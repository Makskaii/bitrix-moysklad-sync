/** The UI and legacy names address CONTACT settings, never COMPANY settings. */
export function canonicalClientFieldEntity(entity: string): string {
  return entity === 'contacts' ? 'contacts-companies' : entity;
}
export function sameClientFieldEntity(candidate: unknown, entity: string): boolean {
  return typeof candidate === 'string' && canonicalClientFieldEntity(candidate) === canonicalClientFieldEntity(entity);
}
