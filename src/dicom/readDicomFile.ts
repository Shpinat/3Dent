import type { ParsedDicomVolume } from './types';
import * as dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstone from '@cornerstonejs/core';
import { initializeCornerstone } from '../cornerstone';

export interface ReadProgress {
  loaded: number;
  total: number;
  stage: 'reading' | 'parsing';
}

export function readDicomFile(
  file: File,
  onProgress: (progress: ReadProgress) => void,
): Promise<ParsedDicomVolume> {
  return readDicomFiles([file], onProgress);
}

export async function readDicomFiles(
  files: File[],
  onProgress: (progress: ReadProgress) => void,
  sourceNameFallback?: string,
): Promise<ParsedDicomVolume> {
  if (files.length === 0) {
    return Promise.reject(new Error('Не выбраны файлы DICOM для загрузки.'));
  }

  await initializeCornerstone();

  // Generate imageIds by adding files to cornerstone dicom-image-loader fileManager
  const imageIds: string[] = [];

  onProgress({ loaded: 0, total: files.length, stage: 'reading' });

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const imageId = dicomImageLoader.wadouri.fileManager.add(file);
    imageIds.push(imageId);

    // Simulate some progress reporting per file added
    if (i % 10 === 0 || i === files.length - 1) {
       onProgress({ loaded: i + 1, total: files.length, stage: 'reading' });
    }
  }

  onProgress({ loaded: files.length, total: files.length, stage: 'parsing' });

  try {
    // Pre-load all images to populate cornerstone metadata for local files
    // This is required for createAndCacheVolume to correctly compute volume dimensions.
    // We process them in batches to prevent UI freezing and memory spikes.
    const batchSize = 10;
    for (let i = 0; i < imageIds.length; i += batchSize) {
      const batch = imageIds.slice(i, i + batchSize);
      await Promise.all(batch.map((id) => cornerstone.imageLoader.loadAndCacheImage(id)));
      onProgress({ loaded: i + batch.length, total: imageIds.length, stage: 'parsing' });
    }
  } catch (error) {
    console.warn("Failed to load and cache some DICOM files", error);
  }

  // Sort imageIds anatomically by projection along their normal vector
  const imageIdsWithProjection = imageIds.map((imageId) => {
    const imagePlane = cornerstone.metaData.get('imagePlaneModule', imageId);
    if (!imagePlane || !imagePlane.imagePositionPatient || !imagePlane.rowCosines || !imagePlane.columnCosines) {
      return { imageId, projection: 0, imagePlane };
    }
    const [ippX, ippY, ippZ] = imagePlane.imagePositionPatient;
    const [rX, rY, rZ] = imagePlane.rowCosines;
    const [cX, cY, cZ] = imagePlane.columnCosines;
    // Calculate normal vector (cross product of row and column)
    const nX = rY * cZ - rZ * cY;
    const nY = rZ * cX - rX * cZ;
    const nZ = rX * cY - rY * cX;

    // Projection of IPP onto normal
    const projection = ippX * nX + ippY * nY + ippZ * nZ;
    return { imageId, projection, imagePlane };
  });

  // Sort the array by projection
  imageIdsWithProjection.sort((a, b) => a.projection - b.projection);
  const sortedImageIds = imageIdsWithProjection.map(item => item.imageId);

  // Extract basic display metadata from the first image
  let patientName = '';
  let patientId = '';
  let studyDate = '';
  let studyDescription = '';
  let seriesDescription = '';
  let manufacturer = '';
  let modality = 'CT';

  try {
    const patientModule = cornerstone.metaData.get('patientModule', sortedImageIds[0]);
    if (patientModule) {
      patientName = patientModule.patientName?.Alphabetic || patientModule.patientName || '';
      patientId = patientModule.patientId || '';
    }

    const generalStudyModule = cornerstone.metaData.get('generalStudyModule', sortedImageIds[0]);
    if (generalStudyModule) {
      studyDate = generalStudyModule.studyDate || '';
      studyDescription = generalStudyModule.studyDescription || '';
    }

    const generalSeriesModule = cornerstone.metaData.get('generalSeriesModule', sortedImageIds[0]);
    if (generalSeriesModule) {
      modality = generalSeriesModule.modality || 'CT';
      seriesDescription = generalSeriesModule.seriesDescription || '';
    }

    const generalEquipmentModule = cornerstone.metaData.get('generalEquipmentModule', sortedImageIds[0]);
    if (generalEquipmentModule) {
      manufacturer = generalEquipmentModule.manufacturer || '';
    }

  } catch (error) {
    console.warn("Failed to extract metadata from the first DICOM file", error);
  }

  const defaultName = files.length === 1 ? files[0].name : (sourceNameFallback || `DICOM серия (${files.length} срезов)`);

  return {
    imageIds: sortedImageIds,
    modality,
    sourceName: defaultName,
    patientName,
    patientId,
    studyDate,
    studyDescription,
    seriesDescription,
    manufacturer,
  };
}
