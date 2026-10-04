import QRCode from "qrcode-terminal/vendor/QRCode/index.js";

export function pairingQrDataUrl(payload: string): string {
  const qr = new QRCode(-1, 1);
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++)
      if (qr.isDark(row, column)) cells.push(`M${column + 4} ${row + 4}h1v1h-1z`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${cells.join("")}" fill="black"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
