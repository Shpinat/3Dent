/// <reference lib="webworker" />

import { parseDicom, type DataSet, type Element } from 'dicom-parser';
import type { SerializedDicomVolume } from './types';

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const PIXEL_DATA_TAG = 'x7fe00010';
const PER_FRAME_GROUPS_TAG = 'x52009230';
const SHARED_GROUPS_TAG = 'x52009229';
const PLANE_POSITION_TAG = 'x00209113';
const PLANE_ORIENTATION_TAG = 'x00209116';
const PIXEL_MEASURES_TAG = 'x00289110';
const FRAME_VOI_LUT_TAG = 'x00289132';
const PIXEL_VALUE_TRANSFORM_TAG = 'x00289145';

function requiredNumber(dataSet: DataSet, tag: string, label: string): number {
  const values = [dataSet.intString(tag), dataSet.uint16(tag), dataSet.floatString(tag)];
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  throw new Error(`В DICOM отсутствует корректный атрибут ${label}.`);
}

function numbers(dataSet: DataSet, tag: string): number[] | undefined {
  const value = dataSet.string(tag);
  if (!value) return undefined;
  const parsed = value.split('\\').map((part) => Number(part.trim()));
  return parsed.every(Number.isFinite) ? parsed : undefined;
}

function firstItem(dataSet: DataSet | undefined, tag: string): DataSet | undefined {
  const element = dataSet?.elements[tag];
  return element?.items?.[0]?.dataSet;
}

function nestedValue(
  frame: DataSet | undefined,
  shared: DataSet | undefined,
  sequenceTag: string,
  valueTag: string,
): number[] | undefined {
  const source = firstItem(frame, sequenceTag) ?? firstItem(shared, sequenceTag) ?? shared ?? frame;
  return source ? numbers(source, valueTag) : undefined;
}

function frameFunctionalGroup(dataSet: DataSet, tag: string, index: number): DataSet | undefined {
  return dataSet.elements[tag]?.items?.[index]?.dataSet;
}

function readPixelValue(
  view: DataView,
  offset: number,
  bitsAllocated: number,
  littleEndian: boolean,
): number {
  if (bitsAllocated === 8) return view.getUint8(offset);
  return view.getUint16(offset, littleEndian);
}

function normalizePixel(
  value: number,
  bitsStored: number,
  highBit: number,
  pixelRepresentation: number,
): number {
  const shift = highBit - bitsStored + 1;
  const storedValue = shift > 0 ? value >>> shift : value;
  const mask = 2 ** bitsStored - 1;
  const masked = storedValue & mask;
  if (pixelRepresentation === 1 && (masked & (2 ** (bitsStored - 1))) !== 0) {
    return masked - 2 ** bitsStored;
  }
  return masked;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseVolume(buffer: ArrayBuffer, sourceName: string): SerializedDicomVolume {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 132 || bytes[128] !== 0x44 || bytes[129] !== 0x49 ||
      bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
    throw new Error('Файл не содержит сигнатуру DICM в позиции 128 и не распознан как Part 10 DICOM.');
  }

  const dataSet = parseDicom(bytes);
  const transferSyntax = dataSet.string('x00020010')?.trim();
  const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
  if (!transferSyntax || !littleEndian || ![
    '1.2.840.10008.1.2',
    '1.2.840.10008.1.2.1',
  ].includes(transferSyntax)) {
    throw new Error(`Transfer Syntax ${transferSyntax ?? 'неизвестен'} не поддерживается. Нужен несжатый Explicit/Implicit VR Little Endian.`);
  }

  const rows = requiredNumber(dataSet, 'x00280010', 'Rows');
  const columns = requiredNumber(dataSet, 'x00280011', 'Columns');
  const numberOfFrames = dataSet.intString('x00280008') ?? 1;
  const bitsAllocated = requiredNumber(dataSet, 'x00280100', 'Bits Allocated');
  const bitsStored = requiredNumber(dataSet, 'x00280101', 'Bits Stored');
  const highBit = requiredNumber(dataSet, 'x00280102', 'High Bit');
  const pixelRepresentation = dataSet.uint16('x00280103') ?? 0;
  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  const photometricInterpretation = dataSet.string('x00280004')?.trim() ?? '';

  if (!Number.isInteger(numberOfFrames) || numberOfFrames < 1 ||
      !Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1) {
    throw new Error('Некорректные размеры изображения или Number of Frames.');
  }
  if (samplesPerPixel !== 1 || !photometricInterpretation.startsWith('MONOCHROME')) {
    throw new Error('Поддерживаются только одноканальные томограммы MONOCHROME1/MONOCHROME2.');
  }
  if (![8, 16].includes(bitsAllocated) || bitsStored > bitsAllocated ||
      bitsStored < 1 || highBit >= bitsAllocated || pixelRepresentation > 1) {
    throw new Error(`Не поддерживается формат пикселей: Bits Allocated ${bitsAllocated}, Bits Stored ${bitsStored}.`);
  }

  const pixelElement: Element | undefined = dataSet.elements[PIXEL_DATA_TAG];
  if (!pixelElement || pixelElement.encapsulatedPixelData) {
    throw new Error('Pixel Data отсутствует либо сжат. Для этого тома требуется несжатый Pixel Data.');
  }

  const voxelCount = rows * columns * numberOfFrames;
  const bytesPerPixel = bitsAllocated / 8;
  const expectedPixelBytes = voxelCount * bytesPerPixel;
  if (!Number.isSafeInteger(voxelCount) ||
      (pixelElement.length !== expectedPixelBytes &&
        !(expectedPixelBytes % 2 === 1 && pixelElement.length === expectedPixelBytes + 1)) ||
      pixelElement.dataOffset + expectedPixelBytes > bytes.byteLength) {
    throw new Error('Размер Pixel Data не соответствует Rows × Columns × Number of Frames.');
  }

  const shared = firstItem(dataSet, SHARED_GROUPS_TAG);
  const perFrame = dataSet.elements[PER_FRAME_GROUPS_TAG]?.items ?? [];
  if (perFrame.length > 0 && perFrame.length !== numberOfFrames) {
    throw new Error('Количество Per-frame Functional Groups не совпадает с Number of Frames.');
  }
  const firstFrame = frameFunctionalGroup(dataSet, PER_FRAME_GROUPS_TAG, 0);

  const rootSpacing = numbers(dataSet, 'x00280030');
  const pixelSpacing = nestedValue(
    shared,
    shared,
    PIXEL_MEASURES_TAG,
    'x00280030',
  ) ?? nestedValue(firstFrame, shared, PIXEL_MEASURES_TAG, 'x00280030') ?? rootSpacing;
  if (!pixelSpacing || pixelSpacing.length < 2 || pixelSpacing[0] <= 0 || pixelSpacing[1] <= 0) {
    throw new Error('В DICOM отсутствует корректный Pixel Spacing.');
  }

  const rootOrientation = numbers(dataSet, 'x00200037');
  const orientation = nestedValue(
    shared,
    shared,
    PLANE_ORIENTATION_TAG,
    'x00200037',
  ) ?? nestedValue(firstFrame, shared, PLANE_ORIENTATION_TAG, 'x00200037') ?? rootOrientation;
  if (!orientation || orientation.length < 6) {
    throw new Error('В DICOM отсутствует Image Orientation Patient.');
  }
  const xAxis = orientation.slice(0, 3);
  const yAxis = orientation.slice(3, 6);
  const rowLength = Math.hypot(...xAxis);
  const columnLength = Math.hypot(...yAxis);
  const axisDot = xAxis[0] * yAxis[0] + xAxis[1] * yAxis[1] + xAxis[2] * yAxis[2];
  const crossProduct = [
    xAxis[1] * yAxis[2] - xAxis[2] * yAxis[1],
    xAxis[2] * yAxis[0] - xAxis[0] * yAxis[2],
    xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0],
  ];
  const normalLength = Math.hypot(...crossProduct);
  if (Math.abs(rowLength - 1) > 0.01 || Math.abs(columnLength - 1) > 0.01 ||
      Math.abs(axisDot) > 0.01 || normalLength < 0.99 || normalLength > 1.01) {
    throw new Error('Image Orientation Patient содержит некорректные векторы.');
  }
  const normal = crossProduct.map((component) => component / normalLength);
  for (let index = 0; index < numberOfFrames; index++) {
    const frame = frameFunctionalGroup(dataSet, PER_FRAME_GROUPS_TAG, index);
    const frameOrientation = nestedValue(
      frame,
      shared,
      PLANE_ORIENTATION_TAG,
      'x00200037',
    );
    if (frameOrientation &&
        frameOrientation.slice(0, 6).some((value, component) =>
          Math.abs(value - orientation[component]) > 0.0001)) {
      throw new Error('Ориентация кадров различается; для этого исследования нельзя построить единый регулярный объем.');
    }
    const framePixelSpacing = nestedValue(frame, shared, PIXEL_MEASURES_TAG, 'x00280030');
    if (framePixelSpacing &&
        framePixelSpacing.slice(0, 2).some((value, component) =>
          Math.abs(value - pixelSpacing[component]) > 0.0001)) {
      throw new Error('Pixel Spacing различается между кадрами; регулярный MPR-объем построить нельзя.');
    }
  }

  const rootPosition = numbers(dataSet, 'x00200032');
  const descriptors = Array.from({ length: numberOfFrames }, (_, index) => {
    const frame = frameFunctionalGroup(dataSet, PER_FRAME_GROUPS_TAG, index);
    const position = nestedValue(frame, shared, PLANE_POSITION_TAG, 'x00200032') ??
      (numberOfFrames === 1 ? rootPosition : undefined);
    const inStackPosition = firstItem(frame, 'x00209111')?.intString('x00209057');
    const projection = position?.length === 3
      ? position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2]
      : undefined;
    return { index, position, projection, inStackPosition };
  });

  const allPositionsKnown = descriptors.every((frame) => frame.projection !== undefined);
  const knownPositionCount = descriptors.filter((frame) => frame.projection !== undefined).length;
  if (knownPositionCount > 0 && !allPositionsKnown) {
    throw new Error('В некоторых кадрах отсутствует Image Position Patient.');
  }
  descriptors.sort((a, b) => {
    if (allPositionsKnown) return a.projection! - b.projection!;
    if (a.inStackPosition !== undefined && b.inStackPosition !== undefined) {
      return a.inStackPosition - b.inStackPosition;
    }
    return a.index - b.index;
  });

  const frameDistances = descriptors.slice(1).flatMap((frame, index) => {
    const previous = descriptors[index];
    return frame.projection !== undefined && previous.projection !== undefined
      ? [Math.abs(frame.projection - previous.projection)]
      : [];
  }).filter((distance) => distance > 0);
  if (allPositionsKnown && frameDistances.length !== numberOfFrames - 1) {
    throw new Error('В нескольких кадрах совпадают позиции срезов; корректный MPR-объем построить нельзя.');
  }
  const frameSpacing = frameDistances.length > 0 ? median(frameDistances) : undefined;
  const sharedMeasures = firstItem(shared, PIXEL_MEASURES_TAG) ??
    firstItem(firstFrame, PIXEL_MEASURES_TAG);
  const sliceThickness = Number.parseFloat(
    sharedMeasures?.string('x00180050') ??
    dataSet.string('x00180050') ??
    '0',
  );
  const declaredSpacing = Number.parseFloat(
    sharedMeasures?.string('x00180088') ??
    dataSet.string('x00180088') ??
    '0',
  );
  const spacingZ = frameSpacing ??
    (Number.isFinite(declaredSpacing) && declaredSpacing > 0 ? declaredSpacing : undefined) ??
    sliceThickness;
  if (!Number.isFinite(spacingZ) || spacingZ <= 0) {
    throw new Error('Не удалось определить положительный шаг между срезами.');
  }
  if (frameDistances.some((distance) => Math.abs(distance - spacingZ) > Math.max(0.02, spacingZ * 0.02))) {
    throw new Error('Позиции кадров имеют неравномерный шаг; построение регулярного MPR-объема небезопасно.');
  }

  const firstPosition = descriptors[0].position ?? rootPosition ?? [0, 0, 0];
  const signed = pixelRepresentation === 1;
  const frameRescales = Array.from({ length: numberOfFrames }, (_, index) => {
    const frame = frameFunctionalGroup(dataSet, PER_FRAME_GROUPS_TAG, index);
    const transform = firstItem(frame, PIXEL_VALUE_TRANSFORM_TAG) ??
      firstItem(shared, PIXEL_VALUE_TRANSFORM_TAG);
    const slope = Number.parseFloat(transform?.string('x00281053') ?? dataSet.string('x00281053') ?? '1');
    const intercept = Number.parseFloat(transform?.string('x00281052') ?? dataSet.string('x00281052') ?? '0');
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
      throw new Error('Некорректные Rescale Slope/Intercept.');
    }
    return { slope, intercept };
  });
  const requiresRescale = frameRescales.some(({ slope, intercept }) => slope !== 1 || intercept !== 0);
  const scalarData = requiresRescale
    ? new Float32Array(voxelCount)
    : bitsAllocated === 8 && !signed
      ? new Uint8Array(voxelCount)
      : signed
        ? new Int16Array(voxelCount)
        : new Uint16Array(voxelCount);
  const view = new DataView(buffer);
  const voxelsPerFrame = rows * columns;
  for (let outputFrame = 0; outputFrame < numberOfFrames; outputFrame++) {
    const { slope, intercept } = frameRescales[descriptors[outputFrame].index];
    const sourceFrame = descriptors[outputFrame].index;
    const sourceOffset = pixelElement.dataOffset + sourceFrame * voxelsPerFrame * bytesPerPixel;
    const destinationOffset = outputFrame * voxelsPerFrame;
    for (let voxel = 0; voxel < voxelsPerFrame; voxel++) {
      const raw = readPixelValue(
        view,
        sourceOffset + voxel * bytesPerPixel,
        bitsAllocated,
        littleEndian,
      );
      const value = normalizePixel(raw, bitsStored, highBit, pixelRepresentation);
      scalarData[destinationOffset + voxel] = requiresRescale
        ? value * slope + intercept
        : value;
    }
  }

  const frameOfReferenceUID = dataSet.string('x00200052')?.trim();
  if (!frameOfReferenceUID) {
    throw new Error('В DICOM отсутствует Frame of Reference UID.');
  }
  const frameVoi = firstItem(shared, FRAME_VOI_LUT_TAG) ??
    firstItem(firstFrame, FRAME_VOI_LUT_TAG);
  const windowCenter = Number.parseFloat(
    dataSet.string('x00281050') ?? frameVoi?.string('x00281050') ?? '40',
  );
  const windowWidth = Number.parseFloat(
    dataSet.string('x00281051') ?? frameVoi?.string('x00281051') ?? '400',
  );
  const frameMetadata: import('@cornerstonejs/core').Types.Metadata = {
    BitsAllocated: bitsAllocated,
    BitsStored: bitsStored,
    SamplesPerPixel: samplesPerPixel,
    HighBit: highBit,
    PhotometricInterpretation: photometricInterpretation,
    PixelRepresentation: pixelRepresentation,
    Modality: dataSet.string('x00080060')?.trim() ?? 'CT',
    SeriesInstanceUID: dataSet.string('x0020000e')?.trim(),
    ImageOrientationPatient: orientation.slice(0, 6),
    PixelSpacing: pixelSpacing.slice(0, 2),
    FrameOfReferenceUID: frameOfReferenceUID,
    Columns: columns,
    Rows: rows,
    voiLut: [],
    VOILUTFunction: dataSet.string('x00281056')?.trim() ?? 'LINEAR',
  };

  return {
    scalarData: scalarData.buffer,
    scalarType: scalarData instanceof Int16Array
      ? 'Int16Array'
      : scalarData instanceof Uint16Array
        ? 'Uint16Array'
        : scalarData instanceof Uint8Array
          ? 'Uint8Array'
          : 'Float32Array',
    metadata: frameMetadata,
    dimensions: [columns, rows, numberOfFrames],
    spacing: [pixelSpacing[1], pixelSpacing[0], spacingZ],
    origin: firstPosition.slice(0, 3) as [number, number, number],
    direction: new Float32Array([
      ...xAxis,
      ...yAxis,
      ...normal,
    ]),
    sliceThickness: Number.isFinite(sliceThickness) && sliceThickness > 0 ? sliceThickness : spacingZ,
    numberOfFrames,
    windowCenter: Number.isFinite(windowCenter) ? windowCenter : 40,
    windowWidth: Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 400,
    isMonochrome1: photometricInterpretation === 'MONOCHROME1',
    modality: dataSet.string('x00080060')?.trim() ?? 'CT',
    sourceName,
  };
}

workerScope.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; sourceName: string }>) => {
  try {
    const result = parseVolume(event.data.buffer, event.data.sourceName);
    workerScope.postMessage(result, [result.scalarData]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обработать DICOM-файл.';
    workerScope.postMessage({ error: message });
  }
};

export {};
