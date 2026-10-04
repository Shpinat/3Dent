import type { Types } from '@cornerstonejs/core';

export type ScalarVolumeData = Int16Array | Uint16Array | Uint8Array | Float32Array;

export interface ViewportState {
  camera?: Types.ICamera;
  voi?: { windowWidth: number; windowCenter: number };
}

export interface VolumeSavedState {
  viewports: Record<string, ViewportState>;
}

export interface ParsedDicomVolume {
  scalarData: ScalarVolumeData;
  metadata: Types.Metadata;
  dimensions: Types.Point3;
  spacing: Types.Point3;
  origin: Types.Point3;
  direction: Types.Mat3;
  sliceThickness: number;
  numberOfFrames: number;
  windowCenter: number;
  windowWidth: number;
  isMonochrome1: boolean;
  modality: string;
  sourceName: string;
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  studyDescription?: string;
  seriesDescription?: string;
  manufacturer?: string;
}

export interface SerializedDicomVolume extends Omit<ParsedDicomVolume, 'scalarData'> {
  scalarData: ArrayBuffer;
  scalarType: 'Int16Array' | 'Uint16Array' | 'Uint8Array' | 'Float32Array';
}
