import * as THREE from "three";

/*
 * Speech bubbles over people's heads ("Bhaago! Robot aaye!"). A small pool of
 * sprites, each with its own canvas texture that is redrawn only when its text changes.
 */

interface Slot { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; text: string; until: number; follow: (() => THREE.Vector3 | null) | null }

export class Bubbles {
  group = new THREE.Group();
  private slots: Slot[] = [];

  constructor(n = 4) {
    for (let i = 0; i < n; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
      sprite.scale.set(4, 1, 1);
      sprite.visible = false;
      sprite.renderOrder = 10;
      this.group.add(sprite);
      this.slots.push({ sprite, canvas, tex, text: "", until: 0, follow: null });
    }
  }

  private draw(s: Slot, text: string, tone: "normal" | "alarm" | "cheer"): void {
    const g = s.canvas.getContext("2d")!;
    g.clearRect(0, 0, 512, 128);
    g.font = `700 40px Rajdhani, "Oxanium Variable", sans-serif`;
    const w = Math.min(500, g.measureText(text).width + 48);
    const x = (512 - w) / 2;
    const color = tone === "alarm" ? "#ff4d6d" : tone === "cheer" ? "#3cff9a" : "#7fe9ff";
    g.fillStyle = "rgba(4,10,12,0.82)";
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(x, 10, w, 84, 18);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(246, 94);
    g.lineTo(256, 118);
    g.lineTo(266, 94);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.fillStyle = "#f2fff9";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 256, 53, w - 30);
    s.tex.needsUpdate = true;
  }

  say(text: string, follow: () => THREE.Vector3 | null, now: number, seconds = 2.6, tone: "normal" | "alarm" | "cheer" = "normal"): void {
    const s = this.slots.find((x) => x.until <= now) ?? this.slots.reduce((a, b) => (a.until < b.until ? a : b));
    if (s.text !== text + tone) { this.draw(s, text, tone); s.text = text + tone; }
    s.until = now + seconds;
    s.follow = follow;
  }

  update(now: number): void {
    for (const s of this.slots) {
      const p = s.until > now && s.follow ? s.follow() : null;
      if (!p) { s.sprite.visible = false; continue; }
      s.sprite.visible = true;
      s.sprite.position.set(p.x, p.y + 2.35, p.z);
      const left = s.until - now;
      (s.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, left * 3);
    }
  }
}
