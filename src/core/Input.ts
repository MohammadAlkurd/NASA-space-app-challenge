/** Keyboard state plus an optional on-screen stick for touch devices. */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private stickX = 0;
  private stickY = 0;
  private stickPointer: number | null = null;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (!this.keys.has(event.code)) this.pressed.add(event.code);
    this.keys.add(event.code);
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  private readonly onBlur = () => this.keys.clear();

  constructor(private readonly stick?: HTMLElement | null, private readonly knob?: HTMLElement | null) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    if (stick) {
      stick.addEventListener('pointerdown', this.onStick);
      stick.addEventListener('pointermove', this.onStick);
      stick.addEventListener('pointerup', this.onStickEnd);
      stick.addEventListener('pointercancel', this.onStickEnd);
    }
  }

  held(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per key press. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }

  /** Forward/back in [-1, 1], forward positive. */
  get throttle(): number {
    const keys = (this.held('KeyW') || this.held('ArrowUp') ? 1 : 0) - (this.held('KeyS') || this.held('ArrowDown') ? 1 : 0);
    return Math.max(-1, Math.min(1, keys - this.stickY));
  }

  /** Steering in [-1, 1], right positive. */
  get steer(): number {
    const keys = (this.held('KeyD') || this.held('ArrowRight') ? 1 : 0) - (this.held('KeyA') || this.held('ArrowLeft') ? 1 : 0);
    return Math.max(-1, Math.min(1, keys + this.stickX));
  }

  get boost(): boolean {
    return this.held('ShiftLeft') || this.held('ShiftRight');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.stick?.removeEventListener('pointerdown', this.onStick);
    this.stick?.removeEventListener('pointermove', this.onStick);
    this.stick?.removeEventListener('pointerup', this.onStickEnd);
    this.stick?.removeEventListener('pointercancel', this.onStickEnd);
  }

  private readonly onStick = (event: PointerEvent) => {
    if (!this.stick) return;
    if (event.type === 'pointerdown') {
      this.stickPointer = event.pointerId;
      this.stick.setPointerCapture?.(event.pointerId);
    }
    if (event.pointerId !== this.stickPointer) return;
    event.preventDefault();
    const rect = this.stick.getBoundingClientRect();
    const radius = rect.width * 0.42;
    let x = (event.clientX - rect.left - rect.width / 2) / radius;
    let y = (event.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    this.stickX = x;
    this.stickY = y;
    this.moveKnob();
  };

  private readonly onStickEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.stickX = 0;
    this.stickY = 0;
    this.moveKnob();
  };

  private moveKnob(): void {
    if (this.knob) this.knob.style.transform = `translate(calc(-50% + ${this.stickX * 38}px), calc(-50% + ${this.stickY * 38}px))`;
  }
}
