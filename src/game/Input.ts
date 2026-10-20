/*
 * Keyboard and mouse. Mouse look uses pointer lock: the first click on the game
 * locks the cursor; Esc releases it (and the page shows the pause menu).
 */

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  fire = false;
  aim = false;
  firePressed = false;
  locked = false;
  wheel = 0;
  private cleanup: (() => void)[] = [];

  constructor(private el: HTMLElement, onLockChange?: (locked: boolean) => void) {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, target: Window | Document | HTMLElement = window) => {
      target.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (["Space", "ArrowUp", "ArrowDown", "Tab"].includes(k)) e.preventDefault();
    });
    on("keyup", (e) => this.keys.delete(e.code));
    on("blur", () => { this.keys.clear(); this.fire = false; this.aim = false; });
    on("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    on("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.fire = true; this.firePressed = true; }
      if (e.button === 2) this.aim = true;
    });
    on("mouseup", (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    on("wheel", (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); });
    on("contextmenu", (e) => { if (this.locked) e.preventDefault(); });
    const lockChange = () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) { this.fire = false; this.aim = false; this.keys.clear(); }
      onLockChange?.(this.locked);
    };
    document.addEventListener("pointerlockchange", lockChange);
    this.cleanup.push(() => document.removeEventListener("pointerlockchange", lockChange));
  }

  requestLock(): void {
    if (document.pointerLockElement === this.el) return;
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* not allowed yet: needs a user gesture */
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per key press. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  axis(neg: string[], pos: string[]): number {
    return (pos.some((k) => this.keys.has(k)) ? 1 : 0) - (neg.some((k) => this.keys.has(k)) ? 1 : 0);
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.firePressed = false;
    this.wheel = 0;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
