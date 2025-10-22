import { Connection, Products, Product } from 'klf-200-api';
import Homey from 'homey';

class VeluxHandler {
    private conn: Connection | null = null;
    private products: Products | null = null;
    private app: Homey.App;

    constructor(app: Homey.App) {
      this.app = app;
    }

    async init() {

      const stopRainingAction = this.app.homey.flow.getActionCard('reconnect');
      stopRainingAction.registerRunListener(async (args, state) => {
        await this.connect();
      });
      await this.connect();

    }

    async connect() {
      this.app.log('Velux connecting');
      const connectionLostTrigger = this.app.homey.flow.getTriggerCard('connection-lost');

      const address = this.app.homey.settings.get('address');
      const password = this.app.homey.settings.get('password');
      if (!address || !password) throw new Error('Missing Velux controller settings');
      this.conn = new Connection(address);
      try {
        await this.conn.loginAsync(password, 5).catch(this.app.error);
        this.conn?.startKeepAlive();
        this.app.log('Velux connected');
      } catch (err) {
        this.app.log('Velux login failed');
        await connectionLostTrigger.trigger();
        throw err;
      }
      this.conn.KLF200SocketProtocol?.onError(async (error) => {
        // TODO: this may be assigned multiple times?
        this.app.log('Velux connection error', error);
        await connectionLostTrigger.trigger();
      });
      try {
      this.products = await Products.createProductsAsync(this.conn);
      /*this.app.homey.drivers.getDrivers().forEach((driver) => {
        this.app.log(`Initializing devices for driver ${driver.deviceTypeName}`);
      });*/
      } catch (error) {
        this.app.error('Failed to create products', error);
      }
    }

    async stop() {
      this.app.log('Velux stopping');
      this.conn?.stopKeepAlive();
      await this.conn?.logoutAsync().catch(this.app.error);
    }

    getProductByNodeID(nodeID: number): Product | undefined {
      if (!this.products) return undefined;
      return this.products.Products.find((product: Product) => product.NodeID === nodeID);
    }
}

export default VeluxHandler;
