export function resolveDemoRootUrl(baseURI: string): URL {
  return new URL("./", baseURI);
}
