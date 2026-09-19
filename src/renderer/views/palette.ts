/** 커맨드 팔레트. design/index.html 에서 옮겼다. */
import { esc, icon } from "../markdown.js";
import { KIND_LABEL, docs, type Doc } from "../state.js";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly hint?: string;
  run(): void;
}

interface Entry {
  readonly label: string;
  readonly icon: string;
  readonly hint: string;
  readonly group: string;
  run(): void;
}

export function openPalette(
  overlay: HTMLElement,
  input: HTMLInputElement,
  list: HTMLElement,
  commands: readonly Command[],
  selectDoc: (doc: Doc) => void,
): void {
  let active = 0;
  let entries: Entry[] = [];

  const build = (query: string): Entry[] => {
    const q = query.trim().toLowerCase();

    const docEntries: Entry[] = docs
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((d) => ({
        label: d.name,
        icon: "i-files",
        hint: KIND_LABEL[d.kind],
        group: "문서",
        run: () => selectDoc(d),
      }));

    const cmdEntries: Entry[] = commands
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ label: c.label, icon: c.icon, hint: c.hint ?? "", group: "명령", run: c.run }));

    return [...docEntries, ...cmdEntries];
  };

  const paint = () => {
    if (entries.length === 0) {
      list.innerHTML = `<div class="palette-group">결과 없음</div>`;
      return;
    }

    let group = "";
    list.innerHTML = entries
      .map((e, i) => {
        const head = e.group === group ? "" : `<div class="palette-group">${esc(e.group)}</div>`;
        group = e.group;
        return `${head}<button class="pcmd" data-i="${i}" aria-selected="${i === active}">
          ${icon(e.icon, "icon icon-sm")}<span class="od-fill od-truncate">${esc(e.label)}</span>
          ${e.hint ? `<span class="hint">${esc(e.hint)}</span>` : ""}
        </button>`;
      })
      .join("");
  };

  const refresh = () => {
    entries = build(input.value);
    active = 0;
    paint();
  };

  const close = () => {
    overlay.hidden = true;
    input.value = "";
    document.removeEventListener("keydown", onKey, true);
  };

  const commit = () => {
    const entry = entries[active];
    close();
    entry?.run();
  };

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, entries.length - 1);
      paint();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  }

  overlay.hidden = false;
  input.oninput = refresh;
  list.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(".pcmd");
    if (!button) return;
    active = Number(button.dataset["i"]);
    commit();
  };
  overlay.onclick = (event) => {
    if (event.target === overlay) close();
  };

  document.addEventListener("keydown", onKey, true);
  refresh();
  input.focus();
}
