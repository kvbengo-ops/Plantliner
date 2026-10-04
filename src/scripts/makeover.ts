// Quantity rules for the optional multi-plant preview. This module has no DOM dependencies.
export const MAX_PLANTS = 8; // kept in step with api/_lib/rules.ts by makeover.test.ts

export type Item = { productId: string; quantity: number };
export type Quantities = Record<string, number>;

export const total = (quantities: Quantities): number =>
  Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);

export function capQuantity(wanted: number, others: number): number {
  const whole = Number.isFinite(wanted) ? Math.floor(wanted) : 0;
  return Math.min(Math.max(whole, 0), Math.max(MAX_PLANTS - others, 0));
}

export const toItems = (quantities: Quantities): Item[] =>
  Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, quantity]) => ({ productId, quantity }));

export function fromItems(items: unknown): Quantities | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const counts = new Map<string, number>();
  let count = 0;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') return null;
    const { productId, quantity } = entry as Partial<Item>;
    if (typeof productId !== 'string' || !productId || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return null;
    count += quantity;
    if (count > MAX_PLANTS) return null;
    counts.set(productId, (counts.get(productId) ?? 0) + quantity);
  }
  return Object.fromEntries(counts);
}

export const summarise = (items: Item[], nameOf: (productId: string) => string): string =>
  items.map(({ productId, quantity }) => `${quantity} × ${nameOf(productId)}`).join(', ');
