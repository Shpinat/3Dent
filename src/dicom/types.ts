export interface ParsedDicomVolume {
  imageIds: string[];
  modality: string;
  sourceName: string;
  patientName?: string;
  patientId?: string;
  studyDate?: string;
  studyDescription?: string;
  seriesDescription?: string;
  manufacturer?: string;
}
