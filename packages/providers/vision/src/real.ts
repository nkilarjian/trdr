// Real VisionProvider — skeleton. GATED: needs an on-device or server vision model.

import type { DetectedSlab, ImageInput, VisionProvider } from "./index.js";

export interface RealVisionConfig {
  /** "apple-vision" (iOS), "mlkit" (Android), or a server endpoint URL. */
  backend?: string;
  endpointUrl?: string;
  apiKey?: string;
}

export class RealVisionProvider implements VisionProvider {
  constructor(readonly config: RealVisionConfig) {}

  async detectSlabs(_image: ImageInput): Promise<DetectedSlab[]> {
    // TODO(vision): detect slab rectangles, then OCR/decode each label's
    //   barcode + cert number (reuse identity's SlabLabelParser per grader).
    //   iOS: VNDetectRectanglesRequest + VNRecognizeTextRequest (on-device).
    //   Android: ML Kit object detection + text recognition.
    //   Or POST the image to a hosted detector (endpointUrl/apiKey).
    throw new Error("RealVisionProvider.detectSlabs not implemented — awaiting a vision backend");
  }
}
