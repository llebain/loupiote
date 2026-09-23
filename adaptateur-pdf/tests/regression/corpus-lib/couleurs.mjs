// Contraste WCAG (formule officielle sRGB -> luminance relative).
export function luminanceRelative([r, g, b]) {
  const f = (c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function ratioContraste(rgb1, rgb2) {
  const L1 = luminanceRelative(rgb1);
  const L2 = luminanceRelative(rgb2);
  const [lHaut, lBas] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (lHaut + 0.05) / (lBas + 0.05);
}
