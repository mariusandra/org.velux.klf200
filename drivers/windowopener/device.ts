import VeluxDevice from '../../lib/VeluxDevice';

module.exports = class WindowOpenerDevice extends VeluxDevice {

  async onInit() {
    this.deviceTypeName = 'Window';
    this.supportsRainSensor = true;
    // klf-200-api already reports window openers open-first (1 = fully open),
    // which is what Homey expects, so this is the one driver that must not
    // flip the position.
    this.invertPosition = false;
    await super.onInit();
  }
};
