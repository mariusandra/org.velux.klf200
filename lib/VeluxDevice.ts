import Homey from 'homey';
import { Product, RunStatus, StatusReply } from 'klf-200-api';

const VeluxApp = require('../app');

export default class VeluxDevice extends Homey.Device {
  public deviceTypeName: string | null = null;
  public supportsRainSensor: boolean = false;
  private product: Product | undefined;
  private tempPosition: number | undefined;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log(`Velux ${this.deviceTypeName} has been initialized`);

    const app = this.homey.app as InstanceType<typeof VeluxApp>;
    const { veluxHandler } = app;

    const data = this.getData();
    this.product = veluxHandler?.getProductByNodeID(data.id);

    this.log('Associated product', this.product?.Name);

    this.product?.propertyChangedEvent.on((property) => {
      this.log('Property changed', property.propertyName, property.propertyValue);

      switch (property.propertyName) {
        case 'CurrentPosition':
          if (this.supportsRainSensor) {
            this.tempPosition = undefined;
          }
          this.log('Setting value', 'windowcoverings_set', property.propertyValue);
          this.setCapabilityValue('windowcoverings_set', property.propertyValue).catch(this.error);
          break;
        case 'TargetPosition':
          if (this.supportsRainSensor) {
            this.tempPosition = property.propertyValue;
          }
          break;
        case 'RunStatus':
          this.setCapabilityValue('alarm_running', property.propertyValue !== RunStatus.ExecutionCompleted).catch(this.error);
          break;
        case 'StatusReply':
          if (this.supportsRainSensor) {
            this.setCapabilityValue('alarm_raining', property.propertyValue === StatusReply.CommandOverruled).catch(this.error);
            if (property.propertyValue === StatusReply.CommandOverruled) {
              this.setCapabilityValue('alarm_running', true).catch(this.error);
              // It is raining, and if the window is already at the limit then it will not resend current position.
              this.homey.setTimeout(() => {
                if (this.tempPosition) {
                  this.setCapabilityValue('windowcoverings_set', this.tempPosition).catch(this.error);
                }
              }, 200);
            }
          }
          break;
        default:
          break;
      }
    });

    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      this.log('Setting value', 'windowcoverings_set', value);

      if (this.product?.Connection.KLF200SocketProtocol)
        await this.product?.setTargetPositionAsync(value as number).catch(this.error);
      else {
        this.setUnavailable('connection_lost');
        const connectionLostTrigger = this.homey.flow.getTriggerCard('connection-lost');
        this.log('Velux connection lost when setting position');
        await connectionLostTrigger.trigger();
      }
    });
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
  }
}