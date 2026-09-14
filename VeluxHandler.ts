import { Connection, Products, Product } from 'klf-200-api';
import Homey from 'homey';

/** How long to wait before the first reconnect attempt. */
const INITIAL_RECONNECT_DELAY = 5_000;

/** Upper bound for the exponential backoff between reconnect attempts. */
const MAX_RECONNECT_DELAY = 300_000;

/** How often to check that the connection is still there. */
const HEALTH_CHECK_INTERVAL = 60_000;

class VeluxHandler {
    private conn: Connection | null = null;
    public products: Products | null = null;
    private app: Homey.App;

    private connecting = false;
    private stopped = false;
    private reconnectDelay = INITIAL_RECONNECT_DELAY;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private healthTimer: NodeJS.Timeout | null = null;

    /**
     * Called after every successful connect, so the app can point its devices
     * at the new Product instances and mark them available again.
     */
    public onConnected: (() => Promise<void>) | null = null;

    constructor(app: Homey.App) {
      this.app = app;
    }

    async init() {
      const reconnectAction = this.app.homey.flow.getActionCard('reconnect');
      reconnectAction.registerRunListener(async () => {
        await this.connect();
      });

      this.healthTimer = this.app.homey.setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL);

      // Never let a failed first attempt escape: the retry loop has to keep
      // running so the app recovers on its own once the gateway comes back.
      await this.connect();
    }

    /** Whether there is a live socket to the gateway right now. */
    get isConnected(): boolean {
      return !!this.conn?.KLF200SocketProtocol;
    }

    /**
     * Queue a reconnect attempt. Repeated calls collapse into one.
     *
     * @param delay Milliseconds to wait, or 0 to try as soon as possible.
     *              Defaults to the current backoff delay.
     */
    public scheduleReconnect(delay?: number): void {
      if (this.stopped || this.reconnectTimer) return;

      const wait = delay ?? this.reconnectDelay;
      this.app.log(`Velux reconnecting in ${Math.round(wait / 1000)}s`);

      this.reconnectTimer = this.app.homey.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => { /* connect() reports and reschedules itself */ });
      }, wait);
    }

    /**
     * Periodic safety net. The gateway sometimes drops a connection without
     * raising an error, and the app used to sit there doing nothing until it
     * was restarted by hand.
     */
    private healthCheck(): void {
      if (this.stopped || this.connecting || this.isConnected) return;
      this.app.log('Velux health check found no connection');
      this.scheduleReconnect(0);
    }

    async connect(): Promise<void> {
      if (this.connecting) return;
      this.connecting = true;

      if (this.reconnectTimer) {
        this.app.homey.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const connectionLostTrigger = this.app.homey.flow.getTriggerCard('connection-lost');
      let failed = false;

      try {
        const address = this.app.homey.settings.get('address');
        const password = this.app.homey.settings.get('password');
        if (!address || !password) throw new Error('Missing Velux controller settings');

        // Close any previous session first. The KLF 200 accepts only two
        // connections at a time and answers ECONNREFUSED once they are taken,
        // so a leaked socket would lock us out of our own gateway.
        await this.disconnect();

        this.app.log('Velux connecting to', address);
        const conn = new Connection(address);
        await conn.loginAsync(password, 5);
        conn.startKeepAlive();
        this.conn = conn;
        this.app.log('Velux connected');

        conn.KLF200SocketProtocol?.onError(async (error) => {
          this.app.log('Velux connection error', error);
          await connectionLostTrigger.trigger().catch(() => { /* not fatal */ });
          this.scheduleReconnect();
        });

        this.products = await Products.createProductsAsync(conn);
        this.app.log(`Velux loaded ${this.products.Products.length} products`);

        this.reconnectDelay = INITIAL_RECONNECT_DELAY;

        if (this.onConnected) {
          await this.onConnected().catch((err) => this.app.error('Rebinding devices failed', err));
        }
      } catch (err) {
        failed = true;
        this.products = null;
        this.app.log('Velux connect failed:', (err as Error)?.message ?? err);
        await connectionLostTrigger.trigger().catch(() => { /* not fatal */ });
      } finally {
        this.connecting = false;
      }

      if (failed) {
        // Schedule first, then grow the delay, so the next failure waits longer.
        this.scheduleReconnect();
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      }
    }

    /**
     * Tear down the current session without touching the retry state.
     */
    private async disconnect(): Promise<void> {
      const conn = this.conn;
      this.conn = null;
      if (!conn) return;

      try {
        conn.stopKeepAlive();
        await conn.logoutAsync();
      } catch (err) {
        this.app.log('Velux logout failed, ignoring:', (err as Error)?.message ?? err);
      }
    }

    async stop() {
      this.app.log('Velux stopping');
      this.stopped = true;

      if (this.reconnectTimer) {
        this.app.homey.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.healthTimer) {
        this.app.homey.clearInterval(this.healthTimer);
        this.healthTimer = null;
      }

      await this.disconnect();
    }

    getProductByNodeID(nodeID: number): Product | undefined {
      if (!this.products) return undefined;
      return this.products.Products.find((product: Product) => product.NodeID === nodeID);
    }
}

export default VeluxHandler;
