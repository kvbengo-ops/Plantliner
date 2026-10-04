import { catalog, byId, type Option } from './catalog.js';
import type { Plan } from './designer.js';
import type { Dims, Item, VisualizationInput } from './rules.js';

// Every word comes from the catalog or from fixed text: customer free text never reaches the model.
export function buildPrompt({ space, plant, style, placement, dims }: Pick<VisualizationInput, 'space' | 'plant' | 'style' | 'placement' | 'dims'>): string {
  const room = space.id === 'other' ? 'space' : space.label.toLowerCase();
  const spot = placement.id === 'auto'
    ? `wherever it looks most natural (it suits being ${plant.placements.map((id) => byId(catalog.placements, id)?.label.toLowerCase()).join(', ')})`
    : placement.prompt;
  const scale = [
    `It is about ${plant.heightCm} cm tall including its pot, and the pot is about ${plant.potDiameterCm} cm wide.`,
    // cm ÷ m = percent of the ceiling height
    dims.ceilingM ? `The ceiling is about ${dims.ceilingM} m high, so the plant reaches roughly ${Math.round(plant.heightCm / dims.ceilingM)}% of the ceiling height.` : '',
    dims.widthM && dims.lengthM ? `The room is roughly ${dims.widthM} m by ${dims.lengthM} m.` : '',
  ].filter(Boolean).join(' ');

  return [
    `Edit the first image, a photo of a real ${room}. Add exactly one ${plant.name}: the potted plant shown in the second image. Place it ${spot}, without blocking doors, walkways or furniture.`,
    'Keep everything else in the first image exactly as it is: walls, windows, floor, ceiling, furniture, objects, lighting, camera angle, perspective and framing. Do not add, remove, move or restyle anything else, and do not add any other plants or decorations.',
    `The plant must clearly be the one in the second image: same species, leaf shape, colours and pot. ${scale} Scale it realistically against the furniture and doors in the room.`,
    "Match the room's light direction, colour temperature and shadows, and give the pot a soft, realistic contact shadow.",
    `Design direction: ${style.label}, ${style.prompt}. Use this only to decide how the plant sits in the space; do not restyle the room.`,
    'The result must look like an unedited photograph of the same room with the plant added.',
  ].join('\n\n');
}

// Total plant makeover. Reference photos follow the room in the same order as `items`, so "image 2" is items[0].
// The plan's furniture notes and placements are the only model-written words, and they sit inside this fixed template.
export function buildMakeoverPrompt({ space, style, items, plan, dims }: { space: Option; style: Option; items: Item[]; plan: Plan; dims: Dims }): string {
  const room = space.id === 'other' ? 'space' : space.label.toLowerCase();
  const references = items.map(({ plant }, i) => `image ${i + 2} is the ${plant.name}`).join('; ');
  const furniture = plan.furniture.length
    ? `You may rearrange only the existing movable seating and tables, as follows:\n${plan.furniture.map((note) => `- ${note}`).join('\n')}\nDo not add, remove, duplicate or restyle any furniture. Keep doors, walkways and exits clear.`
    : 'Do not move, add, remove or restyle any furniture. Keep doors, walkways and exits clear.';
  const plants = plan.plants
    .map((spot) => {
      const plant = items.find((item) => item.plant.id === spot.productId)!.plant; // parsePlan only lets requested products through
      const where = byId(catalog.placements, spot.placement)!.prompt;
      return `- ${spot.count} x ${plant.name}, about ${plant.heightCm} cm tall including its pot, pot about ${plant.potDiameterCm} cm wide: ${where}.`;
    })
    .join('\n');
  const size = [dims.ceilingM ? `The ceiling is about ${dims.ceilingM} m high.` : '', dims.widthM && dims.lengthM ? `The room is roughly ${dims.widthM} m by ${dims.lengthM} m.` : ''].filter(Boolean).join(' ');

  return [
    `Edit the first image, a photo of a real ${room}. The other images are reference photos of potted plants: ${references}.`,
    "Keep the room's architecture exactly as it is: walls, windows, doors, floor, ceiling, fixed fittings, lighting, camera angle, perspective and framing.",
    furniture,
    `Add exactly these plants and no others. Do not add any other plants or decorations. Each must clearly be the plant in its reference photo: same species, leaf shape, colours and pot.\n${plants}`,
    `Scale everything realistically against the furniture and doors. ${size}`.trim(),
    "Match the room's light direction, colour temperature and shadows, and give every pot a soft, realistic contact shadow.",
    `Design direction: ${style.label}, ${style.prompt}. Use this only to guide how the layout feels; do not restyle the room.`,
    'The result must look like an unedited photograph of the same room, rearranged.',
  ].join('\n\n');
}
