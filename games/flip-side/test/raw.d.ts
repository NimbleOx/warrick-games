// Vite's ?raw imports (the tests read the sim's source, to check its arithmetic).
declare module "*?raw" {
  const source: string;
  export default source;
}
