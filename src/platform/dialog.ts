function formatTitleAndMessage(title: string | undefined, message: string) {
  return title ? `${title}\n\n${message}` : message;
}

type ConfirmOptions = {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "warning" | "error" | "info";
};

type AlertOptions = {
  title?: string;
  kind?: "warning" | "error" | "info";
};

type OpenOptions = {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
};

export async function confirmDialog(message: string, options?: ConfirmOptions) {
  const text = formatTitleAndMessage(options?.title, message);
  return window.confirm(text);
}

export async function alertDialog(message: string, options?: AlertOptions) {
  const text = formatTitleAndMessage(options?.title, message);
  window.alert(text);
}

function getAcceptFromFilters(filters?: { name: string; extensions: string[] }[]) {
  if (!filters || filters.length === 0) {
    return undefined;
  }
  const accepts = filters
    .flatMap((filter) => filter.extensions)
    .map((ext) => ext.trim().replace(/^\./, ""))
    .filter(Boolean)
    .map((ext) => `.${ext}`);
  return accepts.length > 0 ? accepts.join(",") : undefined;
}

export async function openFileDialog(options?: OpenOptions): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = Boolean(options?.multiple);

    const directory = Boolean(options?.directory);
    if (directory) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
      input.multiple = false;
    }

    const accept = getAcceptFromFilters(options?.filters);
    if (accept) {
      input.accept = accept;
    }

    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";
    document.body.appendChild(input);

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener(
      "change",
      () => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve(null);
          return;
        }

        if (directory) {
          const first = input.files[0];
          const relative = first?.webkitRelativePath ?? "";
          const root = relative.split("/")[0] ?? "";
          cleanup();
          resolve(root ? `/${root}` : null);
          return;
        }

        const values = Array.from(input.files).map((file) => file.name);
        cleanup();
        if (!options?.multiple) {
          resolve(values[0] ?? null);
          return;
        }
        resolve(values);
      },
      { once: true },
    );

    input.click();
  });
}
