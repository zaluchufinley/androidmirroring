// Remembered settings (UserDefaults in the Mac app): a small JSON file in the user's app-data folder.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  keepOnTop: true,        // stays above other windows
  audioOnPc: false,       // false: sound stays on the phone. true: sound plays on this PC (and the phone is silent)
  phoneScreenOff: false,  // true: the phone's own screen stays off while mirroring
  lastAddress: '',
};

export class Prefs {
  #file;
  #data;

  constructor(dir) {
    this.#file = path.join(dir, 'preferences.json');
    try {
      this.#data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.#file, 'utf8')) };
    } catch {
      this.#data = { ...DEFAULTS };
    }
  }

  get(key) { return this.#data[key]; }
  all() { return { ...this.#data }; }

  set(key, value) {
    if (!(key in DEFAULTS) || this.#data[key] === value) return;
    this.#data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2));
    } catch (e) {
      console.error('Could not save preferences:', e);
    }
  }
}
