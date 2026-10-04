import data from '../../src/data/catalog.json' with { type: 'json' };

// src/data/catalog.json is the single source of truth, read by the site and by this API.
export type Option = { id: string; label: string; prompt?: string };
export type Plant = { id: string; name: string; image: string; heightCm: number; potDiameterCm: number; placements: string[]; description: string };
export type Catalog = { spaceTypes: Option[]; styles: Option[]; placements: Option[]; plants: Plant[] };

export const catalog: Catalog = data;
export const byId = <T extends { id: string }>(list: T[], id: unknown): T | undefined => list.find((item) => item.id === id);
