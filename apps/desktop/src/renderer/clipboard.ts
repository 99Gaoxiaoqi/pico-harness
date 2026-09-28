export async function copyText(text: string): Promise<void> {
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.select();
    if (document.execCommand("copy")) return;
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  await navigator.clipboard.writeText(text);
}
