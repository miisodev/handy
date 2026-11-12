import { drawText, fillRect, strokeRect, type RgbaColor } from "../font.js";
import { parseKeyChord, type ConcreteModifier } from "../keys.js";
import { cropRgba } from "../png.js";
import type {
  DesktopBackend,
  DisplayInfo,
  DoctorCheck,
  MouseButton,
  Point,
  RawFrame,
  Region,
  WindowInfo,
} from "../types.js";

export interface VirtualWidgetState {
  activeWindowId: "workbench" | "scratchpad";
  focusedField: "name" | "notes" | "scratchpad" | null;
  fields: {
    name: string;
    notes: string;
    scratchpad: string;
  };
  clipboard: string;
  selectedAll: boolean;
  submittedValue: string;
  counter: number;
  lastButton: MouseButton | null;
  lastClickCount: number;
  scrollOffset: number;
  cardPosition: Point;
  draggingCard: boolean;
  dragOffset: Point;
  events: string[];
}

export class VirtualDesktopBackend implements DesktopBackend {
  readonly name = "virtual";
  readonly platform = "virtual" as const;

  private readonly width: number;
  private readonly height: number;
  private mouse: Point;
  private heldButtons = new Set<MouseButton>();
  private heldKeys = new Set<string>();
  private lastClickTime = 0;
  private lastClickPos: Point = { x: -1, y: -1 };
  private clickStreak = 0;

  readonly state: VirtualWidgetState = {
    activeWindowId: "workbench",
    focusedField: null,
    fields: {
      name: "",
      notes: "",
      scratchpad: "",
    },
    clipboard: "",
    selectedAll: false,
    submittedValue: "",
    counter: 0,
    lastButton: null,
    lastClickCount: 0,
    scrollOffset: 0,
    cardPosition: { x: 760, y: 150 },
    draggingCard: false,
    dragOffset: { x: 0, y: 0 },
    events: ["Virtual desktop initialized"],
  };

  static readonly LAYOUT = {
    workbenchWindow: { x: 80, y: 80, width: 580, height: 630 },
    scratchpadWindow: { x: 720, y: 310, width: 490, height: 360 },
    scratchpadInput: { x: 745, y: 365, width: 440, height: 280 },
    nameInput: { x: 120, y: 150, width: 360, height: 44 },
    notesInput: { x: 120, y: 230, width: 360, height: 44 },
    submitButton: { x: 120, y: 305, width: 150, height: 42 },
    counterButton: { x: 295, y: 305, width: 185, height: 42 },
    clearButton: { x: 500, y: 305, width: 120, height: 42 },
    scrollBox: { x: 120, y: 390, width: 500, height: 280 },
    cardSize: { width: 220, height: 110 },
  } as const;

  constructor(options: { width?: number; height?: number } = {}) {
    this.width = options.width ?? 1280;
    this.height = options.height ?? 800;
    this.mouse = { x: Math.round(this.width / 2), y: Math.round(this.height / 2) };
  }

  async init(): Promise<void> {}

  async close(): Promise<void> {
    this.heldButtons.clear();
    this.heldKeys.clear();
  }

  async getDisplays(): Promise<DisplayInfo[]> {
    return [
      {
        id: 0,
        name: "Handy Virtual Display",
        x: 0,
        y: 0,
        width: this.width,
        height: this.height,
        scaleFactor: 1,
        primary: true,
      },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    const L = VirtualDesktopBackend.LAYOUT;
    return [
      {
        id: "workbench",
        title: "Agent Control Workbench",
        app: "HandyWorkbench",
        bounds: { ...L.workbenchWindow },
        focused: this.state.activeWindowId === "workbench",
      },
      {
        id: "scratchpad",
        title: "Notes Scratchpad",
        app: "Scratchpad",
        bounds: { ...L.scratchpadWindow },
        focused: this.state.activeWindowId === "scratchpad",
      },
    ];
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    const wins = await this.listWindows();
    return wins.find((w) => w.focused) ?? wins[0] ?? null;
  }

  async focusWindow(query: { title?: string; app?: string; id?: string | number }): Promise<boolean> {
    const wins = await this.listWindows();
    const titleNeedle = query.title?.toLowerCase();
    const appNeedle = query.app?.toLowerCase();
    const match =
      query.id !== undefined
        ? wins.find((w) => String(w.id) === String(query.id))
        : wins.find((w) => {
            if (titleNeedle && w.title.toLowerCase().includes(titleNeedle)) return true;
            if (appNeedle && (w.app ?? "").toLowerCase().includes(appNeedle)) return true;
            return false;
          });
    if (!match) return false;
    this.state.activeWindowId = match.id as "workbench" | "scratchpad";
    if (this.state.activeWindowId === "scratchpad") {
      this.state.focusedField = "scratchpad";
    }
    this.pushEvent(`Focused window "${match.title}"`);
    return true;
  }

  async getClipboardText(): Promise<string> {
    return this.state.clipboard;
  }

  async setClipboardText(text: string): Promise<void> {
    this.state.clipboard = text;
  }

  async getMousePosition(): Promise<Point> {
    return { ...this.mouse };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.mouse = {
      x: Math.max(0, Math.min(this.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(this.height - 1, Math.round(y))),
    };
    if (this.state.draggingCard && this.heldButtons.has("left")) {
      this.state.cardPosition = {
        x: Math.max(40, Math.min(this.width - 260, this.mouse.x - this.state.dragOffset.x)),
        y: Math.max(60, Math.min(this.height - 140, this.mouse.y - this.state.dragOffset.y)),
      };
    }
  }

  private hitRect(p: Point, r: { x: number; y: number; width: number; height: number }): boolean {
    return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  }

  private pushEvent(msg: string): void {
    this.state.events.unshift(msg);
    if (this.state.events.length > 25) {
      this.state.events.length = 25;
    }
  }

  async mouseDown(button: MouseButton): Promise<void> {
    this.heldButtons.add(button);
    this.state.lastButton = button;

    const now = Date.now();
    const nearPrev =
      Math.abs(this.mouse.x - this.lastClickPos.x) <= 6 && Math.abs(this.mouse.y - this.lastClickPos.y) <= 6;
    if (now - this.lastClickTime <= 450 && nearPrev) {
      this.clickStreak += 1;
    } else {
      this.clickStreak = 1;
    }
    this.lastClickTime = now;
    this.lastClickPos = { ...this.mouse };
    this.state.lastClickCount = this.clickStreak;

    if (button === "left") {
      const L = VirtualDesktopBackend.LAYOUT;
      const cardRect = {
        x: this.state.cardPosition.x,
        y: this.state.cardPosition.y,
        width: L.cardSize.width,
        height: L.cardSize.height,
      };

      if (this.hitRect(this.mouse, L.workbenchWindow)) {
        this.state.activeWindowId = "workbench";
      } else if (this.hitRect(this.mouse, L.scratchpadWindow)) {
        this.state.activeWindowId = "scratchpad";
      }

      if (this.hitRect(this.mouse, L.nameInput)) {
        this.state.focusedField = "name";
        this.state.selectedAll = this.clickStreak >= 2;
        this.pushEvent(`Focused Name input (${this.mouse.x},${this.mouse.y})`);
      } else if (this.hitRect(this.mouse, L.notesInput)) {
        this.state.focusedField = "notes";
        this.state.selectedAll = this.clickStreak >= 2;
        this.pushEvent(`Focused Notes input (${this.mouse.x},${this.mouse.y})`);
      } else if (this.hitRect(this.mouse, L.scratchpadInput)) {
        this.state.focusedField = "scratchpad";
        this.state.selectedAll = this.clickStreak >= 2;
        this.pushEvent(`Focused Scratchpad (${this.mouse.x},${this.mouse.y})`);
      } else if (this.hitRect(this.mouse, L.submitButton)) {
        this.state.submittedValue = this.state.fields.name;
        this.pushEvent(`Clicked Submit -> "${this.state.submittedValue}"`);
      } else if (this.hitRect(this.mouse, L.counterButton)) {
        this.state.counter += 1;
        this.pushEvent(`Incremented counter -> ${this.state.counter}`);
      } else if (this.hitRect(this.mouse, L.clearButton)) {
        this.state.fields.name = "";
        this.state.fields.notes = "";
        this.state.submittedValue = "";
        this.state.selectedAll = false;
        this.pushEvent("Cleared form fields");
      } else if (this.hitRect(this.mouse, cardRect)) {
        this.state.draggingCard = true;
        this.state.dragOffset = {
          x: this.mouse.x - this.state.cardPosition.x,
          y: this.mouse.y - this.state.cardPosition.y,
        };
        this.pushEvent(`Started dragging card at (${this.mouse.x},${this.mouse.y})`);
      } else {
        this.state.focusedField = null;
        this.state.selectedAll = false;
        this.pushEvent(`Left click at (${this.mouse.x},${this.mouse.y})`);
      }
    } else {
      this.pushEvent(`${button} click at (${this.mouse.x},${this.mouse.y})`);
    }
  }

  async mouseUp(button: MouseButton): Promise<void> {
    this.heldButtons.delete(button);
    if (button === "left" && this.state.draggingCard) {
      this.state.draggingCard = false;
      this.pushEvent(`Dropped card at (${this.state.cardPosition.x},${this.state.cardPosition.y})`);
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    this.state.scrollOffset = Math.max(0, Math.min(200, this.state.scrollOffset + deltaY * 10));
    this.pushEvent(`Scrolled dx=${deltaX} dy=${deltaY} -> offset=${this.state.scrollOffset}`);
  }

  async keyDown(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "linux");
    this.heldKeys.add(parsed.key);
  }

  async keyUp(key: string): Promise<void> {
    const parsed = parseKeyChord(key, [], "linux");
    this.heldKeys.delete(parsed.key);
  }

  async keyTap(key: string, modifiers: ConcreteModifier[] = []): Promise<void> {
    const modSet = new Set<ConcreteModifier>(modifiers);
    if (this.heldKeys.has("ctrl")) modSet.add("ctrl");
    if (this.heldKeys.has("meta")) modSet.add("meta");
    if (this.heldKeys.has("shift")) modSet.add("shift");
    if (this.heldKeys.has("alt")) modSet.add("alt");

    const field = this.state.focusedField;
    const isCmdOrCtrl = modSet.has("ctrl") || modSet.has("meta");

    if (isCmdOrCtrl && key === "a") {
      if (field) {
        this.state.selectedAll = true;
        this.pushEvent(`Selected all in ${field}`);
      }
      return;
    }

    if (isCmdOrCtrl && key === "c") {
      if (field) {
        this.state.clipboard = this.state.fields[field];
        this.pushEvent(`Copied ${this.state.clipboard.length} chars from ${field}`);
      }
      return;
    }

    if (isCmdOrCtrl && key === "v") {
      if (field && this.state.clipboard) {
        await this.typeText(this.state.clipboard);
      }
      return;
    }

    if (key === "tab") {
      this.state.focusedField = field === "name" ? "notes" : "name";
      this.state.selectedAll = false;
      this.pushEvent(`Tabbed focus -> ${this.state.focusedField}`);
      return;
    }

    if (key === "enter") {
      if (field === "scratchpad") {
        this.state.fields.scratchpad += "\n";
      } else {
        this.state.submittedValue = this.state.fields.name;
        this.pushEvent(`Enter submit -> "${this.state.submittedValue}"`);
      }
      return;
    }

    if (key === "escape") {
      this.state.focusedField = null;
      this.state.selectedAll = false;
      this.pushEvent("Escape -> blurred focus");
      return;
    }

    if ((key === "backspace" || key === "delete") && field) {
      if (this.state.selectedAll) {
        this.state.fields[field] = "";
        this.state.selectedAll = false;
      } else {
        const chars = Array.from(this.state.fields[field]);
        chars.pop();
        this.state.fields[field] = chars.join("");
      }
      return;
    }

    if (key === "space" && field) {
      await this.typeText(" ");
      return;
    }

    if (key.length === 1 && !isCmdOrCtrl && !modSet.has("alt") && field) {
      const ch = modSet.has("shift") ? key.toUpperCase() : key;
      await this.typeText(ch);
      return;
    }

    this.pushEvent(`Key ${[...modSet, key].join("+")}`);
  }

  async typeText(text: string): Promise<void> {
    const field = this.state.focusedField;
    if (!field) {
      this.pushEvent(`Typed "${text}" (no focused input)`);
      return;
    }
    if (this.state.selectedAll) {
      this.state.fields[field] = "";
      this.state.selectedAll = false;
    }
    for (const ch of text) {
      if (ch === "\n") {
        if (field === "scratchpad") {
          this.state.fields.scratchpad += "\n";
        } else {
          this.state.submittedValue = this.state.fields.name;
        }
      } else if (ch !== "\r") {
        this.state.fields[field] += ch;
      }
    }
    this.pushEvent(`Typed ${Array.from(text).length} chars into ${field}`);
  }

  private renderDesktop(): Uint8Array {
    const w = this.width;
    const h = this.height;
    const rgba = new Uint8Array(w * h * 4);

    fillRect(rgba, w, h, 0, 0, w, h, [241, 245, 249, 255]);
    fillRect(rgba, w, h, 0, 0, w, 46, [15, 23, 42, 255]);
    drawText(rgba, w, h, 24, 16, "HANDY VIRTUAL DESKTOP", [248, 250, 252, 255], 2);

    const L = VirtualDesktopBackend.LAYOUT;
    const wbFocused = this.state.activeWindowId === "workbench";
    const spFocused = this.state.activeWindowId === "scratchpad";

    // Main app window card
    fillRect(rgba, w, h, L.workbenchWindow.x, L.workbenchWindow.y, L.workbenchWindow.width, L.workbenchWindow.height, [
      255, 255, 255, 255,
    ]);
    strokeRect(
      rgba,
      w,
      h,
      L.workbenchWindow.x,
      L.workbenchWindow.y,
      L.workbenchWindow.width,
      L.workbenchWindow.height,
      wbFocused ? [14, 165, 233, 255] : [203, 213, 225, 255],
      2,
    );
    drawText(rgba, w, h, 120, 102, "AGENT CONTROL WORKBENCH", [30, 41, 59, 255], 2);

    // Name input
    drawText(rgba, w, h, L.nameInput.x, L.nameInput.y - 16, "NAME:", [71, 85, 105, 255], 1);
    const nameFocused = this.state.focusedField === "name";
    fillRect(rgba, w, h, L.nameInput.x, L.nameInput.y, L.nameInput.width, L.nameInput.height, [248, 250, 252, 255]);
    strokeRect(
      rgba,
      w,
      h,
      L.nameInput.x,
      L.nameInput.y,
      L.nameInput.width,
      L.nameInput.height,
      nameFocused ? [2, 132, 199, 255] : [148, 163, 184, 255],
      nameFocused ? 2 : 1,
    );
    const nameDisplay = this.state.fields.name || (nameFocused ? "|" : "Click here to type...");
    const nameColor: RgbaColor = this.state.fields.name ? [15, 23, 42, 255] : [148, 163, 184, 255];
    drawText(rgba, w, h, L.nameInput.x + 12, L.nameInput.y + 15, nameDisplay.slice(0, 28), nameColor, 2);

    // Notes input
    drawText(rgba, w, h, L.notesInput.x, L.notesInput.y - 16, "NOTES:", [71, 85, 105, 255], 1);
    const notesFocused = this.state.focusedField === "notes";
    fillRect(rgba, w, h, L.notesInput.x, L.notesInput.y, L.notesInput.width, L.notesInput.height, [248, 250, 252, 255]);
    strokeRect(
      rgba,
      w,
      h,
      L.notesInput.x,
      L.notesInput.y,
      L.notesInput.width,
      L.notesInput.height,
      notesFocused ? [2, 132, 199, 255] : [148, 163, 184, 255],
      notesFocused ? 2 : 1,
    );
    const notesDisplay = this.state.fields.notes || (notesFocused ? "|" : "Secondary field");
    const notesColor: RgbaColor = this.state.fields.notes ? [15, 23, 42, 255] : [148, 163, 184, 255];
    drawText(rgba, w, h, L.notesInput.x + 12, L.notesInput.y + 15, notesDisplay.slice(0, 28), notesColor, 2);

    // Buttons
    fillRect(rgba, w, h, L.submitButton.x, L.submitButton.y, L.submitButton.width, L.submitButton.height, [
      2, 132, 199, 255,
    ]);
    drawText(rgba, w, h, L.submitButton.x + 38, L.submitButton.y + 14, "SUBMIT", [255, 255, 255, 255], 2);

    fillRect(rgba, w, h, L.counterButton.x, L.counterButton.y, L.counterButton.width, L.counterButton.height, [
      16, 185, 129, 255,
    ]);
    drawText(
      rgba,
      w,
      h,
      L.counterButton.x + 18,
      L.counterButton.y + 14,
      `COUNT: ${this.state.counter}`,
      [255, 255, 255, 255],
      2,
    );

    fillRect(rgba, w, h, L.clearButton.x, L.clearButton.y, L.clearButton.width, L.clearButton.height, [
      100, 116, 139, 255,
    ]);
    drawText(rgba, w, h, L.clearButton.x + 30, L.clearButton.y + 14, "CLEAR", [255, 255, 255, 255], 2);

    if (this.state.submittedValue) {
      fillRect(rgba, w, h, 120, 356, 500, 26, [220, 252, 231, 255]);
      strokeRect(rgba, w, h, 120, 356, 500, 26, [34, 197, 94, 255], 1);
      drawText(
        rgba,
        w,
        h,
        130,
        365,
        `SUBMITTED: ${this.state.submittedValue}`.slice(0, 64),
        [22, 101, 52, 255],
        1,
      );
    }

    // Event log
    fillRect(rgba, w, h, L.scrollBox.x, L.scrollBox.y, L.scrollBox.width, L.scrollBox.height, [15, 23, 42, 255]);
    drawText(
      rgba,
      w,
      h,
      L.scrollBox.x + 12,
      L.scrollBox.y + 10,
      `EVENT LOG (SCROLL=${this.state.scrollOffset})`,
      [56, 189, 248, 255],
      1,
    );
    const startIdx = Math.min(Math.floor(this.state.scrollOffset / 20), Math.max(0, this.state.events.length - 1));
    for (let i = 0; i < 12; i++) {
      const ev = this.state.events[startIdx + i];
      if (!ev) break;
      drawText(rgba, w, h, L.scrollBox.x + 12, L.scrollBox.y + 32 + i * 18, ev.slice(0, 76), [226, 232, 240, 255], 1);
    }

    // Secondary window: Notes Scratchpad
    fillRect(
      rgba,
      w,
      h,
      L.scratchpadWindow.x,
      L.scratchpadWindow.y,
      L.scratchpadWindow.width,
      L.scratchpadWindow.height,
      [255, 255, 255, 255],
    );
    strokeRect(
      rgba,
      w,
      h,
      L.scratchpadWindow.x,
      L.scratchpadWindow.y,
      L.scratchpadWindow.width,
      L.scratchpadWindow.height,
      spFocused ? [14, 165, 233, 255] : [203, 213, 225, 255],
      2,
    );
    drawText(rgba, w, h, L.scratchpadWindow.x + 24, L.scratchpadWindow.y + 20, "NOTES SCRATCHPAD", [30, 41, 59, 255], 2);
    fillRect(
      rgba,
      w,
      h,
      L.scratchpadInput.x,
      L.scratchpadInput.y,
      L.scratchpadInput.width,
      L.scratchpadInput.height,
      [248, 250, 252, 255],
    );
    strokeRect(
      rgba,
      w,
      h,
      L.scratchpadInput.x,
      L.scratchpadInput.y,
      L.scratchpadInput.width,
      L.scratchpadInput.height,
      this.state.focusedField === "scratchpad" ? [2, 132, 199, 255] : [203, 213, 225, 255],
      1,
    );
    const spLines = (this.state.fields.scratchpad || "Ready for paste or multi-line notes...").split("\n");
    for (let i = 0; i < Math.min(12, spLines.length); i++) {
      drawText(
        rgba,
        w,
        h,
        L.scratchpadInput.x + 12,
        L.scratchpadInput.y + 14 + i * 18,
        spLines[i]!.slice(0, 62),
        this.state.fields.scratchpad ? [15, 23, 42, 255] : [148, 163, 184, 255],
        1,
      );
    }

    // Draggable sticky card
    const cx = this.state.cardPosition.x;
    const cy = this.state.cardPosition.y;
    fillRect(rgba, w, h, cx, cy, L.cardSize.width, L.cardSize.height, [254, 243, 199, 255]);
    strokeRect(rgba, w, h, cx, cy, L.cardSize.width, L.cardSize.height, [245, 158, 11, 255], 2);
    drawText(rgba, w, h, cx + 14, cy + 16, "DRAG CARD", [146, 64, 14, 255], 2);
    drawText(rgba, w, h, cx + 14, cy + 48, `POS: ${cx},${cy}`, [180, 83, 9, 255], 1);

    return rgba;
  }

  async captureScreen(options: { display?: number; region?: Region } = {}): Promise<RawFrame> {
    const full = this.renderDesktop();
    if (options.region) {
      const cropped = cropRgba(
        full,
        this.width,
        this.height,
        options.region.x,
        options.region.y,
        options.region.width,
        options.region.height,
      );
      return {
        width: cropped.width,
        height: cropped.height,
        data: cropped.data,
        originX: cropped.x,
        originY: cropped.y,
        logicalWidth: cropped.width,
        logicalHeight: cropped.height,
        scaleFactor: 1,
        displayId: 0,
      };
    }

    return {
      width: this.width,
      height: this.height,
      data: full,
      originX: 0,
      originY: 0,
      logicalWidth: this.width,
      logicalHeight: this.height,
      scaleFactor: 1,
      displayId: 0,
    };
  }

  async doctor(): Promise<DoctorCheck[]> {
    return [
      {
        name: "Virtual Desktop Backend",
        ok: true,
        detail: `Ready (${this.width}x${this.height} interactive multi-window virtual screen)`,
      },
    ];
  }
}
