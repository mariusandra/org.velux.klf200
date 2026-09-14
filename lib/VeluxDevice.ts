import Homey from 'homey';
import { Product, RunStatus, StatusReply } from 'klf-200-api';

const VeluxApp = require('../app');

type PropertyChangedEvent = {
  readonly o: unknown;
  readonly propertyName: string;
  readonly propertyValue: unknown;
};

export default class VeluxDevice extends Homey.Device {
  public deviceTypeName: string | null = null;
  public supportsRainSensor: boolean = false;

  /**
   * Whether the Velux position scale runs opposite to Homey's.
   *
   * klf-200-api reports a position where 1 means "fully open" for only a
   * handful of actuator types: window openers, lights, on/off switches,
   * ventilation points and exterior heating. For every other type - roller
   * shutters, venetian blinds, awnings, garage openers - the library reports
   * the fraction *closed*, so 1 means fully closed.
   *
   * Homey's `windowcoverings_set` is always 1 = open, 0 = closed, so those
   * other types need the value flipped in both directions. Drivers whose
   * actuator type the library already reports open-first set this to false.
   */
  public invertPosition: boolean = true;

  private product: Product | undefined;
  private tempPosition: number | undefined;
  private propertyListener: ((property: PropertyChangedEvent) => void) | undefined;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log(`Velux ${this.deviceTypeName} has been initialized`);

    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      this.log('Setting value', 'windowcoverings_set', value);

      if (!this.product?.Connection.KLF200SocketProtocol) {
        this.log('Velux connection lost when setting position');
        await this.setUnavailable(this.homey.__('errors.not_connected')).catch((err) => this.error(err));

        const connectionLostTrigger = this.homey.flow.getTriggerCard('connection-lost');
        await connectionLostTrigger.trigger().catch((err) => this.error(err));

        // Ask the app to reconnect straight away so the device recovers
        // without the user having to restart anything.
        const app = this.homey.app as InstanceType<typeof VeluxApp>;
        app.veluxHandler?.scheduleReconnect(0);

        throw new Error(this.homey.__('errors.not_connected'));
      }

      const veluxValue = this.toVeluxScale(value as number);
      const currentRaw = this.product.CurrentPositionRaw;
      const sessionID = await this.product.setTargetPositionAsync(veluxValue);
      this.log(`Sent position homey=${value} velux=${veluxValue} raw=${Math.round(0xc800 * veluxValue)}`
        + ` fromRaw=${currentRaw}${currentRaw === 0xf7ff ? ' (UNKNOWN)' : ''} session=${sessionID}`);
    });

    await this.bindProduct();
  }

  /**
   * Attach this device to the Product instance of the current gateway
   * connection.
   *
   * Called on init and again after every reconnect, because
   * Products.createProductsAsync() builds a completely fresh set of Product
   * objects - the old ones stop emitting events and their commands go
   * nowhere. Safe to call repeatedly.
   */
  async bindProduct(): Promise<void> {
    const app = this.homey.app as InstanceType<typeof VeluxApp>;
    const { veluxHandler } = app;

    this.detachProduct();

    const { id } = this.getData();
    const product = veluxHandler?.getProductByNodeID(id);

    if (!product) {
      this.log('No product found for node', id);
      await this.setUnavailable(this.homey.__('errors.not_connected')).catch((err) => this.error(err));
      return;
    }

    this.product = product;
    this.log('Associated product', product.Name);
    this.log(`Product detail: node=${product.NodeID} type=${product.TypeID} subType=${product.SubType}`
      + ` variation=${product.NodeVariation} state=${product.State}`
      + ` currentRaw=${product.CurrentPositionRaw} targetRaw=${product.TargetPositionRaw}`
      + ` runStatus=${product.RunStatus} statusReply=${product.StatusReply}`);

    this.propertyListener = (property: PropertyChangedEvent) => this.onPropertyChanged(property);
    product.propertyChangedEvent.on(this.propertyListener);

    this.syncPosition();
    await this.setAvailable().catch((err) => this.error(err));

    // Ask the gateway for the current node state. Without this the position
    // stays empty until something else moves the blind, and an empty
    // capability is why the slider cannot be dragged to a position.
    product.refreshAsync().catch((err: Error) => this.log('Could not refresh product state', err?.message ?? err));
  }

  /**
   * Stop listening to the product this device was previously bound to.
   */
  private detachProduct(): void {
    if (this.product && this.propertyListener) {
      this.product.propertyChangedEvent.off(this.propertyListener);
    }
    this.propertyListener = undefined;
    this.product = undefined;
    this.tempPosition = undefined;
  }

  private onPropertyChanged(property: PropertyChangedEvent): void {
    this.log('Property changed', property.propertyName, property.propertyValue);

    switch (property.propertyName) {
      case 'CurrentPosition':
        if (this.supportsRainSensor) {
          this.tempPosition = undefined;
        }
        this.setPosition(property.propertyValue as number);
        break;
      case 'TargetPosition':
        if (this.supportsRainSensor) {
          this.tempPosition = property.propertyValue as number;
        }
        break;
      case 'RunStatus':
        this.setCapabilityValue('alarm_running', property.propertyValue !== RunStatus.ExecutionCompleted)
          .catch((err) => this.error(err));
        break;
      case 'StatusReply':
        if (this.supportsRainSensor) {
          this.setCapabilityValue('alarm_raining', property.propertyValue === StatusReply.CommandOverruled)
            .catch((err) => this.error(err));
          if (property.propertyValue === StatusReply.CommandOverruled) {
            this.setCapabilityValue('alarm_running', true).catch((err) => this.error(err));
            // It is raining, and if the window is already at the limit then it will not resend current position.
            this.homey.setTimeout(() => {
              if (this.tempPosition !== undefined) {
                this.setPosition(this.tempPosition);
              }
            }, 200);
          }
        }
        break;
      default:
        break;
    }
  }

  /**
   * Read the position the gateway currently holds for this product and
   * publish it to Homey.
   */
  private syncPosition(): void {
    if (!this.product) return;
    this.setPosition(this.product.CurrentPosition);
  }

  /**
   * Publish a Velux-scale position on the Homey capability.
   */
  private setPosition(veluxValue: number): void {
    if (!Number.isFinite(veluxValue)) {
      // The gateway answers 0xF7FF ("position unknown") for a product it has
      // not seen move since its last restart, which klf-200-api turns into
      // NaN. Homey rejects NaN, so publishing it would only leave the
      // capability empty and log an error on every update.
      this.log('Gateway reports an unknown position, leaving the capability as it is');
      return;
    }

    const homeyValue = this.toHomeyScale(veluxValue);
    this.log('Setting value', 'windowcoverings_set', homeyValue);
    this.setCapabilityValue('windowcoverings_set', homeyValue).catch((err) => this.error(err));
  }

  /**
   * Velux scale -> Homey scale. The mapping is its own inverse.
   */
  private toHomeyScale(value: number): number {
    return this.invertPosition ? 1 - value : value;
  }

  /**
   * Homey scale -> Velux scale. The mapping is its own inverse.
   */
  private toVeluxScale(value: number): number {
    return this.invertPosition ? 1 - value : value;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log(`Velux ${this.deviceTypeName} has been added`);
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log(`Velux ${this.deviceTypeName} settings where changed`);
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log(`Velux ${this.deviceTypeName} was renamed`);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log(`Velux ${this.deviceTypeName} has been deleted`);
    this.detachProduct();
  }

  /**
   * onUninit is called when the device is destroyed, for instance when the
   * app restarts.
   */
  async onUninit() {
    this.detachProduct();
  }
}
