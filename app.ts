'use strict';

import Homey from 'homey';
import VeluxHandler from './VeluxHandler';

const { Log } = require('homey-log');

module.exports = class VeluxApp extends Homey.App {
  veluxHandler: VeluxHandler | null = null;
  homeyLog: any;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.homeyLog = new Log({ homey: this.homey });
    this.log('VeluxApp has been initialized');

    this.veluxHandler = new VeluxHandler(this);

    // Every reconnect replaces the Product instances, so each device has to be
    // pointed at the new ones and marked available again.
    this.veluxHandler.onConnected = async () => {
      await this.rebindDevices();
    };

    try {
      await this.veluxHandler.init();
      this.log('VeluxHandler initialized and keep-alive started');
    } catch (err) {
      // init() keeps its own retry loop running, so this is only a safety net.
      this.log('VeluxHandler failed to initialize', err);
    }
  }

  /**
   * Point every paired device at the products of the current connection.
   */
  async rebindDevices(): Promise<void> {
    const drivers = this.homey.drivers.getDrivers();

    await Promise.all(Object.values(drivers).map(async (driver) => {
      await driver.ready().catch(() => { /* driver not ready yet, its devices bind on their own init */ });

      return Promise.all(driver.getDevices().map(async (device) => {
        const veluxDevice = device as Homey.Device & { bindProduct?: () => Promise<void> };
        if (typeof veluxDevice.bindProduct !== 'function') return;
        await veluxDevice.bindProduct().catch((err: Error) => this.error('Could not rebind device', err));
      }));
    }));
  }

  async onUninit() {
    this.log('VeluxApp is being uninitialized');
    await this.veluxHandler?.stop();
  }
};
