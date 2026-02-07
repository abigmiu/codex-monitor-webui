export type ContextMenuItem = {
  label?: string;
  onSelect?: () => void | Promise<void>;
  enabled?: boolean;
  danger?: boolean;
  separator?: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export async function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "platform-context-menu";
  menu.setAttribute("role", "menu");

  const cleanup = () => {
    window.removeEventListener("mousedown", handleOutside);
    window.removeEventListener("keydown", handleEscape);
    menu.remove();
  };

  const handleOutside = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && menu.contains(target)) {
      return;
    }
    cleanup();
  };

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      cleanup();
    }
  };

  const actionableItems = items.filter((item) => item.separator || item.label);
  actionableItems.forEach((item) => {
    if (item.separator) {
      const divider = document.createElement("div");
      divider.className = "platform-context-menu-separator";
      menu.appendChild(divider);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = `platform-context-menu-item${item.danger ? " is-danger" : ""}`;
    button.textContent = item.label ?? "";
    button.disabled = item.enabled === false;
    button.addEventListener("click", () => {
      cleanup();
      if (item.enabled === false || !item.onSelect) {
        return;
      }
      void item.onSelect();
    });
    menu.appendChild(button);
  });

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = clamp(x, 8, Math.max(8, window.innerWidth - rect.width - 8));
  const top = clamp(y, 8, Math.max(8, window.innerHeight - rect.height - 8));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  window.addEventListener("mousedown", handleOutside);
  window.addEventListener("keydown", handleEscape);
}

export async function showContextMenuFromEvent(
  event: MouseEvent | React.MouseEvent,
  items: ContextMenuItem[],
) {
  event.preventDefault();
  event.stopPropagation();
  await showContextMenu(event.clientX, event.clientY, items);
}
