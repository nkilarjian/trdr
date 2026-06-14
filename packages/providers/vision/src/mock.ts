// Mock VisionProvider — simulates reading a photo of a stack of slabs. Returns a
// realistic batch: most cards read cleanly (high confidence + cert), a few are
// glare/blur/partial and come back low-confidence for the user to confirm.
// The cert numbers resolve via the mock GradingProvider so a real library forms.

import type { DetectedSlab, ImageInput, VisionProvider } from "./index.js";

const DETECTIONS: DetectedSlab[] = [
  { id: "d1", grader: "PSA", certGuess: "58127634", confidence: 0.97, cropUrl: "https://img.test/crop1.jpg", boundingBox: { x: 0.04, y: 0.05, w: 0.28, h: 0.42 } },
  { id: "d2", grader: "PSA", certGuess: "58127699", confidence: 0.95, cropUrl: "https://img.test/crop2.jpg", boundingBox: { x: 0.36, y: 0.05, w: 0.28, h: 0.42 } },
  { id: "d3", grader: "CGC", certGuess: "4012887001", confidence: 0.93, cropUrl: "https://img.test/crop3.jpg", boundingBox: { x: 0.68, y: 0.05, w: 0.28, h: 0.42 } },
  { id: "d4", grader: "PSA", certGuess: "71045511", confidence: 0.91, cropUrl: "https://img.test/crop4.jpg", boundingBox: { x: 0.04, y: 0.52, w: 0.28, h: 0.42 } },
  { id: "d5", grader: "PSA", certGuess: "62330180", confidence: 0.88, cropUrl: "https://img.test/crop5.jpg", boundingBox: { x: 0.36, y: 0.52, w: 0.28, h: 0.42 } },
  { id: "d6", grader: "SGC", certGuess: "9921007", confidence: 0.86, cropUrl: "https://img.test/crop6.jpg", boundingBox: { x: 0.68, y: 0.52, w: 0.28, h: 0.42 } },
  { id: "d7", grader: "PSA", certGuess: "55012345", confidence: 0.82, cropUrl: "https://img.test/crop7.jpg", boundingBox: { x: 0.04, y: 0.05, w: 0.28, h: 0.42 } },
  // ── low-confidence: glare / blur / partial — routed to review ──
  { id: "d8", grader: "PSA", certGuess: "5812", confidence: 0.58, cropUrl: "https://img.test/crop8.jpg", boundingBox: { x: 0.36, y: 0.05, w: 0.28, h: 0.42 } },
  { id: "d9", confidence: 0.44, cropUrl: "https://img.test/crop9.jpg", boundingBox: { x: 0.68, y: 0.05, w: 0.28, h: 0.42 } },
  { id: "d10", confidence: 0.39, cropUrl: "https://img.test/crop10.jpg", boundingBox: { x: 0.04, y: 0.52, w: 0.28, h: 0.42 } },
];

export class MockVisionProvider implements VisionProvider {
  async detectSlabs(_image: ImageInput): Promise<DetectedSlab[]> {
    return DETECTIONS;
  }
}
