import { catalog, byId } from './catalog.js';
import type { VisualizationInput } from './rules.js';

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
