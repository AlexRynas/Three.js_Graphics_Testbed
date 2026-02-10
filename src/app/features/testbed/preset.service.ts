import { Injectable, signal } from '@angular/core';
import { Preset } from './controls.model';

const STORAGE_KEY = 'graphics-testbed-presets';

@Injectable({ providedIn: 'root' })
export class PresetService {
  private readonly presetsSignal = signal<Preset[]>(this.load());
  readonly presets = this.presetsSignal.asReadonly();

  setInitialPresets(presets: Preset[]): void {
    if (this.presetsSignal().length === 0) {
      this.presetsSignal.set(presets);
      this.save(presets);
    }
  }

  savePreset(preset: Preset): void {
    const existing = this.presetsSignal().filter((item) => item.name !== preset.name);
    const next = [...existing, preset];
    this.presetsSignal.set(next);
    this.save(next);
  }

  deletePreset(name: string): void {
    const next = this.presetsSignal().filter((item) => item.name !== name);
    this.presetsSignal.set(next);
    this.save(next);
  }

  private save(presets: Preset[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch {
      // Ignore storage failures.
    }
  }

  private load(): Preset[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Preset[]) : [];
    } catch {
      return [];
    }
  }
}
