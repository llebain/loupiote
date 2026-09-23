// Utilitaires texte pour les metriques de corpus (couverture, duplication).
// Aucune dependance npm.

/**
 * Normalise une chaine pour comparaison : NFC, minuscules, ponctuation
 * retiree, espaces multiples ecrases. Retourne un tableau de mots.
 */
export function normaliserMots(texte) {
  if (!texte) return [];
  const nfc = texte.normalize('NFC').toLowerCase();
  // \p{P} = ponctuation Unicode ; \p{S} exclu volontairement (garde les
  // symboles comme ✶ ➜ qui sont le contenu qu'on veut pouvoir suivre).
  const sansPonct = nfc.replace(/[\p{P}]/gu, ' ');
  return sansPonct.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Longueur de la plus longue sous-suite commune (mots), ordre respecte.
 * DP a 2 lignes (espace O(min(n,m))).
 */
export function longueurSousSuiteCommune(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  // a = plus courte pour minimiser la memoire
  if (a.length > b.length) [a, b] = [b, a];
  let prev = new Array(a.length + 1).fill(0);
  for (let j = 1; j <= b.length; j++) {
    const cur = new Array(a.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      if (a[i - 1] === b[j - 1]) cur[i] = prev[i - 1] + 1;
      else cur[i] = Math.max(prev[i], cur[i - 1]);
    }
    prev = cur;
  }
  return prev[a.length];
}

/**
 * couverture = mots source retrouves dans la sortie, sans tenir compte de
 * l'ordre : somme( min(n_source(w), n_sortie(w)) ) / |source|. Mesure la
 * PERTE de contenu seule.
 */
export function couverture(motsSource, motsSortie) {
  if (motsSource.length === 0) return 1;
  const compteSortie = new Map();
  for (const w of motsSortie) compteSortie.set(w, (compteSortie.get(w) || 0) + 1);
  let trouves = 0;
  for (const w of motsSource) {
    const n = compteSortie.get(w) || 0;
    if (n > 0) { trouves++; compteSortie.set(w, n - 1); }
  }
  return trouves / motsSource.length;
}

/**
 * ordre = |LCS(source, sortie)| / |source|, dans [0,1]. Mesure perte ET
 * desordre, contre l'ordre des blocs d'extraction (__DEBUG_BLOCKS__), qui
 * n'est PAS l'ordre de lecture sur une mise en page 2D (ex. Sq4 : grille
 * 2x2, 100 % des mots presents mais ordre = 0,42). Valeur absolue a
 * interpreter avec prudence ; utile surtout en differentiel.
 */
export function ordre(motsSource, motsSortie) {
  if (motsSource.length === 0) return 1;
  const lcs = longueurSousSuiteCommune(motsSource, motsSortie);
  return lcs / motsSource.length;
}

/**
 * duplication = somme( max(0, n_sortie(w) - n_source(w)) ) / |mots source|
 * Mots de sortie en exces par rapport au multiensemble de la source.
 */
export function duplication(motsSource, motsSortie) {
  if (motsSource.length === 0) return 0;
  const compteSource = new Map();
  for (const w of motsSource) compteSource.set(w, (compteSource.get(w) || 0) + 1);
  const compteSortie = new Map();
  for (const w of motsSortie) compteSortie.set(w, (compteSortie.get(w) || 0) + 1);
  let excedent = 0;
  for (const [w, n] of compteSortie) {
    const nSrc = compteSource.get(w) || 0;
    if (n > nSrc) excedent += n - nSrc;
  }
  return excedent / motsSource.length;
}

export function mediane(arr) {
  if (!arr.length) return 0;
  const tri = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(tri.length / 2);
  return tri.length % 2 ? tri[mid] : (tri[mid - 1] + tri[mid]) / 2;
}
