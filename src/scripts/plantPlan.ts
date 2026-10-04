import catalog from '../data/catalog.json';
import { toJpegBase64 } from './photo';
import { MAX_PLANTS, capQuantity, fromItems, summarise, toItems, total, type Quantities } from './makeover';

type Layout = { furniture: string[]; plants: { productId: string; count: number; placement: string; why: string }[] };
type Visualization = {
  status: 'processing' | 'succeeded' | 'failed';
  mode?: 'single' | 'makeover'; // absent on previews saved before the makeover existed
  items: { productId: string; quantity: number }[];
  choices: { spaceType: string; style: string; placement: string };
  rationale?: string | null;
  layout?: Layout | null;
  before: string | null;
  after: string | null;
};

const AI_LABEL = 'Approximate AI preview. Plant size and placement may differ in real life.';
const SINGLE_INTRO = 'Choose one plant, a style, and a spot. Add a room photo above to see an approximate AI preview. You can continue without creating one.';
const PRIVACY_WITH_MAKEOVER = 'Your photo is processed by our AI providers (Kie, and Groq for a makeover) to create the preview.';
const MAKEOVER_INTRO = 'Choose your plants and how many of each. We rearrange the seating and tables around them and explain why. Add a room photo above to see an approximate AI preview. You can continue without creating one.';

const ID_PATTERN = /^[A-Za-z0-9]{20}$/;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const REQUEST_PHOTO_LIMIT = 10 * 1024 * 1024;
const PREVIEW_PHOTO_LIMIT = 25 * 1024 * 1024;
const POLL_INTERVAL = 4_000;
const POLL_TIMEOUT = 10 * 60_000;

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing form element: ${selector}`);
  return found;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("We couldn't connect. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `The request failed (HTTP ${response.status}). Please try again.`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

function validImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export function initPlantPlan(previewEnabled: boolean, makeoverEnabled = false): void {
  const form = element<HTMLFormElement>('#plant-plan-form');
  const contact = element<HTMLInputElement>('#contact');
  const contactLabel = element<HTMLLabelElement>('#contact-label');
  const photo = element<HTMLInputElement>('#photo');
  const photoLabel = element<HTMLElement>('#photo-label');
  const photoHint = element<HTMLElement>('#photo-hint');
  const success = element<HTMLElement>('#form-success');
  const formSteps = [...document.querySelectorAll<HTMLElement>('.form-step')];
  const progressItems = [...document.querySelectorAll<HTMLElement>('.wizard-progress li')];
  const stepCount = element<HTMLElement>('#step-count');
  const progressFill = element<HTMLElement>('#progress-fill');
  const submitButton = element<HTMLButtonElement>('#enquiry-submit');
  const submitError = element<HTMLElement>('#submit-error');
  const submitStatus = element<HTMLElement>('#submit-status');
  const previewSection = element<HTMLElement>('#plant-preview');
  const previewEntry = element<HTMLElement>('#preview-entry');
  const plantError = element<HTMLElement>('#preview-plant-error');
  const choiceError = element<HTMLElement>('#preview-choice-error');
  const previewError = element<HTMLElement>('#preview-error');
  const previewStatusMessage = element<HTMLElement>('#preview-status');
  const generateButton = element<HTMLButtonElement>('#preview-generate');
  const againButton = element<HTMLButtonElement>('#preview-again');
  const result = element<HTMLElement>('#preview-result');
  const resultTitle = element<HTMLElement>('#preview-result-title');
  const beforeImage = element<HTMLImageElement>('#preview-before');
  const afterImage = element<HTMLImageElement>('#preview-after');
  const lightbox = element<HTMLDialogElement>('#preview-lightbox');
  const lightboxImage = element<HTMLImageElement>('#preview-lightbox-image');
  const lightboxTitle = element<HTMLElement>('#preview-lightbox-title');
  const lightboxClose = element<HTMLButtonElement>('#preview-lightbox-close');
  const shareLink = element<HTMLAnchorElement>('#preview-share');
  const style = element<HTMLSelectElement>('#preview-style');
  const placement = element<HTMLSelectElement>('#preview-placement');
  const name = element<HTMLInputElement>('#name');
  const notes = element<HTMLTextAreaElement>('#notes');
  const light = element<HTMLSelectElement>('#light');
  const size = element<HTMLSelectElement>('#size');
  const modeGroup = element<HTMLElement>('#preview-modes');
  const modeRadios = [...form.querySelectorAll<HTMLInputElement>('input[name="previewMode"]')];
  const previewIntro = element<HTMLElement>('#preview-intro');
  const privacy = element<HTMLElement>('#preview-privacy');
  const singlePicker = element<HTMLElement>('#single-picker');
  const makeoverPicker = element<HTMLElement>('#makeover-picker');
  const placementField = element<HTMLElement>('#preview-placement-field');
  const makeoverError = element<HTMLElement>('#makeover-error');
  const makeoverTotal = element<HTMLElement>('#makeover-total');
  const generateLabel = element<HTMLElement>('#preview-generate-label');
  const qtyInputs = [...makeoverPicker.querySelectorAll<HTMLInputElement>('[data-qty-input]')];
  const qtySteps = [...makeoverPicker.querySelectorAll<HTMLButtonElement>('[data-qty-step]')];
  const aiLabel = element<HTMLElement>('#preview-ai-label');
  const design = element<HTMLElement>('#preview-design');
  const rationale = element<HTMLElement>('#preview-rationale');
  const moves = element<HTMLElement>('#preview-moves');
  const spots = element<HTMLElement>('#preview-spots');

  previewSection.hidden = !previewEnabled;
  previewEntry.hidden = !previewEnabled;
  modeGroup.hidden = !(previewEnabled && makeoverEnabled);
  if (makeoverEnabled) privacy.textContent = PRIVACY_WITH_MAKEOVER; // Groq only sees photos once the makeover exists
  photoHint.textContent = previewEnabled
    ? 'JPG, PNG, or WebP · up to 25 MB for a preview; 10 MB for a request without one'
    : 'JPG, PNG, or WebP · up to 10 MB';

  let currentStep = 0;
  let mode: 'single' | 'makeover' = 'single';
  let visualizationId: string | null = null;
  let previewState: 'none' | Visualization['status'] = 'none';
  let previewToken = 0;
  let pollTimer: number | undefined;
  let pollStartedAt = 0;
  let creating = false;
  let submitting = false;

  const openPhoto = (source: HTMLImageElement, title: string) => {
    const url = new URL(source.currentSrc || source.src, location.href);
    if (url.protocol !== 'https:' && url.origin !== location.origin) return;
    lightboxImage.src = url.href;
    lightboxImage.alt = source.alt || title;
    lightboxTitle.textContent = title;
    lightbox.showModal();
    lightboxClose.focus();
  };
  result.querySelectorAll<HTMLButtonElement>('[data-preview-image]').forEach((button) => {
    button.addEventListener('click', () => {
      const isBefore = button.dataset.previewImage === 'before';
      openPhoto(isBefore ? beforeImage : afterImage, isBefore ? 'Before' : 'After');
    });
  });
  previewSection.querySelectorAll<HTMLButtonElement>('[data-plant-image]').forEach((button) => {
    button.addEventListener('click', () => {
      const plant = catalog.plants.find((item) => item.id === button.dataset.plantImage);
      const source = button.parentElement?.querySelector<HTMLImageElement>('img');
      if (plant && source) openPhoto(source, plant.name);
    });
  });
  lightboxClose.addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener('close', () => lightboxImage.removeAttribute('src'));

  const chosenSpace = () => form.querySelector<HTMLInputElement>('input[name="space"]:checked');
  const chosenPlant = () => form.querySelector<HTMLInputElement>('input[name="productId"]:checked');
  const selectedPlant = () => catalog.plants.find((plant) => plant.id === chosenPlant()?.value);
  const plantName = (productId: string) => catalog.plants.find((plant) => plant.id === productId)?.name ?? productId;
  const quantities = (): Quantities => Object.fromEntries(qtyInputs.map((input) => [input.dataset.qtyInput!, Number(input.value) || 0]));
  // Keeps the "N of 8" label, each input's max, the "−/+" availability and the highlighted cards in step with the numbers.
  const renderQuantities = () => {
    const current = quantities();
    const count = total(current);
    makeoverTotal.textContent = `${count} of ${MAX_PLANTS} plants`;
    qtyInputs.forEach((input) => {
      const id = input.dataset.qtyInput!;
      input.max = String(current[id] + MAX_PLANTS - count);
      input.closest('.makeover-card')?.classList.toggle('is-chosen', current[id] > 0);
    });
    // aria-disabled, not disabled: a button that disables itself under the keyboard drops focus.
    qtySteps.forEach((button) => {
      const atLimit = button.dataset.qtyStep === '1' ? count >= MAX_PLANTS : current[button.dataset.qtyPlant!] <= 0;
      button.setAttribute('aria-disabled', String(atLimit));
    });
  };
  const setQuantities = (next: Quantities) => {
    qtyInputs.forEach((input) => { input.value = String(next[input.dataset.qtyInput!] ?? 0); });
    renderQuantities();
  };
  const setMode = (next: 'single' | 'makeover') => {
    mode = next;
    modeRadios.forEach((radio) => { radio.checked = radio.value === next; });
    singlePicker.hidden = next !== 'single';
    makeoverPicker.hidden = next !== 'makeover';
    placementField.hidden = next !== 'single';
    previewIntro.textContent = next === 'single' ? SINGLE_INTRO : MAKEOVER_INTRO;
    generateLabel.textContent = next === 'single' ? 'Create my preview' : 'Create my makeover';
    againButton.textContent = next === 'single' ? 'Try another look' : 'Try another layout';
  };
  const setMessage = (target: HTMLElement, message: string) => {
    target.textContent = message;
    target.hidden = !message;
  };
  const showStep = (step: number, focus = true) => {
    currentStep = step;
    formSteps.forEach((panel, index) => { panel.hidden = index !== step; });
    progressItems.forEach((item, index) => {
      item.classList.toggle('is-complete', index < step);
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    stepCount.textContent = `0${step + 1} / 03`;
    progressFill.style.transform = `scaleX(${(step + 1) / formSteps.length})`;
    if (focus) formSteps[step]?.querySelector<HTMLElement>('h3')?.focus();
  };
  const clearFieldError = (field: HTMLElement, errorId: string) => {
    field.removeAttribute('aria-invalid');
    element<HTMLElement>(`#${errorId}`).textContent = '';
  };
  const query = new URL(location.href);
  const changeQuery = (key: string, value: string | null) => {
    const url = new URL(location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    history.replaceState(history.state, '', url);
  };
  const setGenerateAvailability = () => {
    generateButton.hidden = !previewEnabled || previewState === 'processing' || previewState === 'succeeded';
    generateButton.disabled = creating;
    generateButton.setAttribute('aria-busy', String(creating));
  };
  const clearPreview = (clearLink = true) => {
    if (lightbox.open) lightbox.close();
    previewToken += 1;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    visualizationId = null;
    previewState = 'none';
    result.hidden = true;
    design.hidden = true;
    beforeImage.removeAttribute('src');
    afterImage.removeAttribute('src');
    shareLink.href = '/#enquiry';
    setMessage(previewStatusMessage, '');
    setMessage(previewError, '');
    setGenerateAvailability();
    if (clearLink) changeQuery('visualization', null);
  };
  const updatePlacements = (preferred = '') => {
    const plant = selectedPlant();
    placement.replaceChildren(new Option(plant ? 'Choose a placement' : 'Choose a plant first', ''));
    if (!plant) { placement.disabled = true; return; }
    const allowed = new Set(['auto', ...plant.placements]);
    catalog.placements.filter((option) => allowed.has(option.id)).forEach((option) => {
      placement.add(new Option(option.label, option.id));
    });
    placement.disabled = false;
    if (allowed.has(preferred)) placement.value = preferred;
  };
  const validatePhoto = (limit: number): File | null | false => {
    const file = photo.files?.[0] ?? null;
    if (!file) return null;
    const message = !PHOTO_TYPES.includes(file.type)
      ? 'Choose a JPG, PNG, or WebP image.'
      : file.size > limit
        ? `Please choose a photo under ${limit / (1024 * 1024)} MB.`
        : '';
    setMessage(element<HTMLElement>('#photo-error'), message);
    photo.toggleAttribute('aria-invalid', !!message);
    if (message) { photo.focus(); return false; }
    return file;
  };
  const validateStep = (step: number) => {
    if (step === 0) {
      if (chosenSpace()) return true;
      element<HTMLElement>('#space-error').textContent = 'Please choose a type of space.';
      form.querySelector<HTMLInputElement>('input[name="space"]')?.focus();
      return false;
    }
    if (step === 1) {
      if (!chosenSpace()) {
        showStep(0);
        element<HTMLElement>('#space-error').textContent = 'Please choose a type of space.';
        form.querySelector<HTMLInputElement>('input[name="space"]')?.focus();
        return false;
      }
      return validatePhoto(previewEnabled ? PREVIEW_PHOTO_LIMIT : REQUEST_PHOTO_LIMIT) !== false;
    }
    clearFieldError(name, 'name-error');
    clearFieldError(contact, 'contact-error');
    let firstInvalid: HTMLElement | undefined;
    if (!name.value.trim()) {
      element<HTMLElement>('#name-error').textContent = 'Please enter your name.';
      name.setAttribute('aria-invalid', 'true');
      firstInvalid = name;
    }
    if (!contact.value.trim() || !contact.checkValidity()) {
      element<HTMLElement>('#contact-error').textContent = contact.type === 'tel' ? 'Please enter a valid phone number.' : 'Please enter a valid email address.';
      contact.setAttribute('aria-invalid', 'true');
      firstInvalid ||= contact;
    }
    firstInvalid?.focus();
    return !firstInvalid;
  };

  const shareUrl = (id: string) => {
    const url = new URL('/', location.origin);
    url.searchParams.set('visualization', id);
    url.hash = 'enquiry';
    return url.href;
  };
  // The "How we designed it" panel. Everything the model wrote goes in as text, never as HTML.
  const renderDesign = (data: Visualization) => {
    moves.replaceChildren();
    spots.replaceChildren();
    const layout = data.layout;
    if (data.mode !== 'makeover' || typeof data.rationale !== 'string' || !data.rationale || !layout) { design.hidden = true; return; }
    rationale.textContent = data.rationale;
    (Array.isArray(layout.furniture) ? layout.furniture : []).forEach((note) => {
      const item = document.createElement('li');
      item.textContent = String(note);
      moves.append(item);
    });
    (Array.isArray(layout.plants) ? layout.plants : []).forEach((spot) => {
      const plant = catalog.plants.find((item) => item.id === spot.productId);
      if (!plant) return;
      const where = catalog.placements.find((item) => item.id === spot.placement);
      const item = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = `${spot.count} × ${plant.name}`;
      item.append(strong, document.createTextNode(`${where ? `, ${where.label.toLowerCase()}` : ''}. ${spot.why}`));
      spots.append(item);
    });
    design.hidden = false;
  };
  const applyVisualization = (id: string, data: Visualization): boolean => {
    const makeover = data.mode === 'makeover';
    const restored = makeover ? fromItems(data.items) : null;
    const productId = data.items?.[0]?.productId;
    const plant = catalog.plants.find((item) => item.id === productId);
    const space = catalog.spaceTypes.find((item) => item.id === data.choices?.spaceType);
    const styleOption = catalog.styles.find((item) => item.id === data.choices?.style);
    const choicesKnown = makeover
      ? makeoverEnabled && !!restored && Object.keys(restored).every((key) => catalog.plants.some((item) => item.id === key))
      : !!plant;
    if (!choicesKnown || !space || !styleOption || !['processing', 'succeeded', 'failed'].includes(data.status)) {
      clearPreview();
      setMessage(previewError, 'This preview could not be restored because its choices are missing.');
      return false;
    }
    const spaceRadio = form.querySelector<HTMLInputElement>(`input[name="space"][value="${space.id}"]`);
    if (spaceRadio) spaceRadio.checked = true;
    style.value = styleOption.id;
    setMode(makeover ? 'makeover' : 'single');
    if (makeover) {
      setQuantities(restored!);
    } else {
      const plantRadio = form.querySelector<HTMLInputElement>(`input[name="productId"][value="${plant!.id}"]`);
      if (plantRadio) plantRadio.checked = true;
      updatePlacements(data.choices.placement);
      if (placement.value !== data.choices.placement) {
        clearPreview();
        setMessage(previewError, 'This preview has a placement that is not available for this plant.');
        return false;
      }
    }
    visualizationId = id;
    previewState = data.status;
    setMessage(previewError, '');
    if (data.status === 'succeeded') {
      if (!validImageUrl(data.before) || !validImageUrl(data.after)) {
        setMessage(previewError, 'The preview is ready, but its image links are missing. Please reopen the result link.');
        setGenerateAvailability();
        return false;
      }
      beforeImage.src = data.before;
      afterImage.src = data.after;
      resultTitle.textContent = makeover ? `Your space, rearranged with ${total(restored!)} plants` : `${plant!.name} in your space`;
      aiLabel.textContent = makeover ? `${AI_LABEL} The furniture moves are a suggestion, not a measured plan.` : AI_LABEL;
      renderDesign(data);
      shareLink.href = shareUrl(id);
      result.hidden = false;
      setMessage(previewStatusMessage, 'Your preview is ready.');
      changeQuery('visualization', id);
    } else if (data.status === 'failed') {
      visualizationId = null;
      setMessage(previewStatusMessage, '');
      setMessage(previewError, 'Preview generation failed. Please try again, or continue without a preview.');
      changeQuery('visualization', null);
    } else {
      setMessage(previewStatusMessage, 'Creating your preview. You can continue to contact while you wait.');
      changeQuery('visualization', id);
    }
    setGenerateAvailability();
    return true;
  };
  const poll = async (id: string, token: number): Promise<void> => {
    if (token !== previewToken) return;
    if (Date.now() - pollStartedAt >= POLL_TIMEOUT) {
      previewState = 'failed';
      visualizationId = null;
      changeQuery('visualization', null);
      setMessage(previewStatusMessage, '');
      setMessage(previewError, 'The preview timed out after 10 minutes. Please try again, or continue without one.');
      setGenerateAvailability();
      return;
    }
    try {
      const data = await apiJson<Visualization>(`/api/visualizations/${encodeURIComponent(id)}`);
      if (token !== previewToken) return;
      if (!applyVisualization(id, data) || data.status !== 'processing') return;
    } catch (error) {
      if (token !== previewToken) return;
      setMessage(previewError, error instanceof Error ? error.message : 'Could not check the preview. Please try again.');
      if (error instanceof ApiError && error.status === 404) {
        previewState = 'failed';
        visualizationId = null;
        changeQuery('visualization', null);
        setMessage(previewStatusMessage, '');
        setGenerateAvailability();
        return;
      }
    }
    if (token === previewToken) pollTimer = window.setTimeout(() => { void poll(id, token); }, POLL_INTERVAL);
  };
  const startPolling = (id: string) => {
    const token = previewToken;
    pollStartedAt = Date.now();
    void poll(id, token);
  };

  form.querySelectorAll<HTMLInputElement>('input[name="space"]').forEach((radio) => radio.addEventListener('change', () => {
    element<HTMLElement>('#space-error').textContent = '';
    if (previewEnabled) clearPreview();
  }));
  form.querySelectorAll<HTMLButtonElement>('[data-next]').forEach((button) => button.addEventListener('click', () => {
    if (validateStep(currentStep)) showStep(currentStep + 1);
  }));
  form.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((button) => button.addEventListener('click', () => showStep(currentStep - 1)));
  document.querySelectorAll<HTMLInputElement>('input[name="contactMethod"]').forEach((radio) => radio.addEventListener('change', () => {
    if (!radio.checked) return;
    const isPhone = radio.value === 'Phone';
    contact.type = isPhone ? 'tel' : 'email';
    contact.inputMode = isPhone ? 'tel' : 'email';
    contact.autocomplete = isPhone ? 'tel' : 'email';
    contact.placeholder = isPhone ? 'Your phone number' : 'you@example.com';
    if (isPhone) contact.pattern = '[0-9 +\\(\\)\\-]{7,}';
    else contact.removeAttribute('pattern');
    contactLabel.innerHTML = `${isPhone ? 'Phone number' : 'Email address'} <span class="required-label">(required)</span>`;
    contact.value = '';
    clearFieldError(contact, 'contact-error');
  }));
  document.querySelectorAll<HTMLAnchorElement>('[data-space]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const space = form.querySelector<HTMLInputElement>(`input[name="space"][value="${link.dataset.space}"]`);
    if (space) {
      if (!space.checked && previewEnabled) clearPreview();
      space.checked = true;
      element<HTMLElement>('#space-error').textContent = '';
    }
    success.hidden = true;
    form.hidden = false;
    showStep(0, false);
    location.hash = 'enquiry';
  }));
  [name, contact].forEach((field) => field.addEventListener('input', () => clearFieldError(field, `${field.id}-error`)));
  photo.addEventListener('change', () => {
    photoLabel.textContent = photo.files?.[0]?.name || 'Choose a photo to share';
    clearFieldError(photo, 'photo-error');
    if (previewEnabled) clearPreview();
  });
  if (previewEnabled) {
    form.querySelectorAll<HTMLInputElement>('input[name="productId"]').forEach((radio) => radio.addEventListener('change', () => {
      updatePlacements();
      setMessage(plantError, '');
      clearPreview();
    }));
    style.addEventListener('change', () => { setMessage(choiceError, ''); clearPreview(); });
    placement.addEventListener('change', () => { setMessage(choiceError, ''); clearPreview(); });
    modeRadios.forEach((radio) => radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setMode(radio.value === 'makeover' ? 'makeover' : 'single');
      setMessage(plantError, '');
      setMessage(makeoverError, '');
      setMessage(choiceError, '');
      clearPreview();
    }));
    // Setting a quantity never lets the total pass the cap; changing anything invalidates an earlier preview.
    const setQuantity = (productId: string, wanted: number) => {
      const current = quantities();
      const next = capQuantity(wanted, total(current) - (current[productId] ?? 0));
      setQuantities({ ...current, [productId]: next });
      setMessage(makeoverError, wanted > next ? `We can design up to ${MAX_PLANTS} plants at once.` : '');
      clearPreview();
    };
    qtyInputs.forEach((input) => input.addEventListener('change', () => setQuantity(input.dataset.qtyInput!, Number(input.value))));
    qtySteps.forEach((button) => button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') {
        if (button.dataset.qtyStep === '1') setMessage(makeoverError, `We can design up to ${MAX_PLANTS} plants at once.`);
        return;
      }
      const productId = button.dataset.qtyPlant!;
      setQuantity(productId, (quantities()[productId] ?? 0) + Number(button.dataset.qtyStep));
    }));
    renderQuantities();
    generateButton.addEventListener('click', async () => {
      if (creating || previewState === 'processing' || previewState === 'succeeded') return;
      setMessage(previewError, '');
      setMessage(plantError, '');
      setMessage(makeoverError, '');
      setMessage(choiceError, '');
      if (!chosenSpace()) {
        showStep(0);
        validateStep(0);
        return;
      }
      let choices: Record<string, unknown>;
      if (mode === 'makeover') {
        const items = toItems(quantities());
        if (!items.length) {
          setMessage(makeoverError, 'Choose at least one plant.');
          qtyInputs[0]?.focus();
          return;
        }
        if (!catalog.styles.some((item) => item.id === style.value)) {
          setMessage(choiceError, 'Choose a style.');
          style.focus();
          return;
        }
        choices = { mode: 'makeover', items, style: style.value };
      } else {
        if (!selectedPlant()) {
          setMessage(plantError, 'Choose a plant for your preview.');
          form.querySelector<HTMLInputElement>('input[name="productId"]')?.focus();
          return;
        }
        const plant = selectedPlant()!;
        const validPlacement = placement.value === 'auto' || plant.placements.includes(placement.value);
        if (!catalog.styles.some((item) => item.id === style.value) || !catalog.placements.some((item) => item.id === placement.value) || !validPlacement) {
          setMessage(choiceError, 'Choose a style and an available placement.');
          (style.value ? placement : style).focus();
          return;
        }
        choices = { productId: plant.id, style: style.value, placement: placement.value };
      }
      const file = validatePhoto(PREVIEW_PHOTO_LIMIT);
      if (file === false) return;
      if (!file) {
        setMessage(previewError, 'Add a photo of your space to create a preview.');
        photo.focus();
        return;
      }
      creating = true;
      setGenerateAvailability();
      setMessage(previewStatusMessage, 'Preparing your photo…');
      const token = previewToken;
      try {
        const image = await toJpegBase64(file);
        if (token !== previewToken) return;
        const created = await apiJson<{ id: string }>('/api/visualizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image, spaceType: chosenSpace()!.value, ...choices }),
        });
        if (token !== previewToken) return;
        if (!ID_PATTERN.test(created.id)) throw new Error('The preview service returned an invalid result ID.');
        visualizationId = created.id;
        previewState = 'processing';
        changeQuery('visualization', created.id);
        setMessage(previewStatusMessage, 'Creating your preview. You can continue to contact while you wait.');
        startPolling(created.id);
      } catch (error) {
        if (token === previewToken) {
          setMessage(previewStatusMessage, '');
          const closed = mode === 'makeover' && error instanceof ApiError && error.status === 404; // the server flag is still off
          setMessage(previewError, closed ? 'The total plant makeover is not available yet.' : error instanceof Error ? error.message : 'Could not create a preview. Please try again.');
        }
      } finally {
        creating = false;
        setGenerateAvailability();
      }
    });
    againButton.addEventListener('click', () => {
      clearPreview();
      if (!photo.files?.[0]) {
        setMessage(previewError, 'Choose a room photo to make another preview.');
        photo.focus();
      } else generateButton.focus();
    });
    const requestedPlant = query.searchParams.get('plant');
    if (requestedPlant) {
      const radio = form.querySelector<HTMLInputElement>(`input[name="productId"][value="${requestedPlant.replace(/[^a-z0-9-]/g, '')}"]`);
      if (radio && radio.value === requestedPlant) { radio.checked = true; updatePlacements(); }
      else changeQuery('plant', null);
    }
    const requestedVisualization = query.searchParams.get('visualization');
    if (requestedVisualization) {
      if (!ID_PATTERN.test(requestedVisualization)) {
        changeQuery('visualization', null);
        showStep(1);
        setMessage(previewError, 'This preview link is not valid.');
      } else {
        visualizationId = requestedVisualization;
        previewState = 'processing';
        showStep(1);
        setMessage(previewStatusMessage, 'Restoring your preview…');
        setGenerateAvailability();
        startPolling(requestedVisualization);
      }
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!validateStep(currentStep)) return;
    if (currentStep < formSteps.length - 1) { showStep(currentStep + 1); return; }
    setMessage(submitError, '');
    const attachedPreview = previewEnabled && !!visualizationId && (previewState === 'processing' || previewState === 'succeeded');
    const file = attachedPreview ? null : validatePhoto(REQUEST_PHOTO_LIMIT);
    if (file === false) { showStep(1, false); photo.focus(); return; }
    submitting = true;
    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    setMessage(submitStatus, 'Sending your request…');
    try {
      const payload: Record<string, string> = {
        space: chosenSpace()?.value || '',
        light: light.value,
        size: size.value,
        notes: notes.value,
        name: name.value.trim(),
        contactMethod: form.querySelector<HTMLInputElement>('input[name="contactMethod"]:checked')?.value || 'Email',
        contact: contact.value.trim(),
      };
      if (previewEnabled && mode === 'single' && chosenPlant()) payload.productId = chosenPlant()!.value;
      // The enquiry carries one product, so a makeover's plants travel in the notes, and in the preview when one is attached.
      const chosenItems = previewEnabled && mode === 'makeover' ? toItems(quantities()) : [];
      if (chosenItems.length) payload.notes = [notes.value, `Plants chosen for the makeover: ${summarise(chosenItems, plantName)}`].filter(Boolean).join('\n\n');
      if (attachedPreview && visualizationId) payload.visualizationId = visualizationId;
      else if (file) payload.photo = await toJpegBase64(file);
      const saved = await apiJson<{ id: string }>('/api/enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!ID_PATTERN.test(saved.id)) throw new Error('The request service returned an invalid confirmation. Please contact us.');
      const summary = element<HTMLElement>('#request-summary');
      summary.replaceChildren();
      const rows = [
        ['Space', chosenSpace()?.closest('label')?.querySelector('span')?.textContent || 'Your space'],
        ['Contact by', payload.contactMethod],
        ['Light', light.selectedOptions[0]?.text || 'Not sure'],
      ];
      if (previewEnabled && mode === 'single' && selectedPlant()) rows.push(['Plant', selectedPlant()!.name]);
      if (chosenItems.length) rows.push(['Plants', summarise(chosenItems, plantName)]);
      rows.forEach(([label, value]) => {
        const row = document.createElement('p');
        const key = document.createElement('strong');
        key.textContent = `${label}: `;
        row.append(key, document.createTextNode(value));
        summary.append(row);
      });
      form.hidden = true;
      success.hidden = false;
      success.focus();
    } catch (error) {
      setMessage(submitError, error instanceof Error ? error.message : 'Could not send your request. Please try again.');
      submitError.focus();
    } finally {
      submitting = false;
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      setMessage(submitStatus, '');
    }
  });

  element<HTMLButtonElement>('#start-again').addEventListener('click', () => {
    form.reset();
    contact.type = 'email';
    contact.inputMode = 'email';
    contact.autocomplete = 'email';
    contact.placeholder = 'you@example.com';
    contact.removeAttribute('pattern');
    contactLabel.innerHTML = 'Email address <span class="required-label">(required)</span>';
    photoLabel.textContent = 'Choose a photo to share';
    document.querySelectorAll<HTMLElement>('.field-error').forEach((error) => { error.textContent = ''; error.hidden = error.id === 'preview-error' || error.id === 'submit-error'; });
    document.querySelectorAll<HTMLElement>('[aria-invalid]').forEach((field) => field.removeAttribute('aria-invalid'));
    if (previewEnabled) { setMode('single'); renderQuantities(); updatePlacements(); clearPreview(); changeQuery('plant', null); }
    success.hidden = true;
    form.hidden = false;
    showStep(0);
  });
}
