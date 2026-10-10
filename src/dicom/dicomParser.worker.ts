/// <reference lib="webworker" />

import { parseDicom, type DataSet, type Element } from 'dicom-parser';
import { decode as decodeJpegBaseline } from 'jpeg-js';
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';
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
const MEDIA_STORAGE_SOP_CLASS_TAG = 'x00020002';
const DICOM_DIRECTORY_STORAGE_UID = '1.2.840.10008.1.3.10';

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

function decodeString(dataSet: DataSet, tag: string): string | undefined {
  const element = dataSet.elements[tag];
  if (!element || element.length === 0) return undefined;

  const rawString = dataSet.string(tag);
  if (!rawString) return undefined;

  let cleaned = rawString.replace(/\0/g, '').trim();
  if (cleaned.length === 0) return undefined;

  // Remove formatting caret delimiters (e.g. Last^First -> Last First)
  cleaned = cleaned.replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Try to read directly from raw bytes using windows-1251 decoder.
  // This bypasses dicom-parser's internal string decoding which corrupts some Russian charsets.
  try {
    const bytes = new Uint8Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + element.dataOffset, element.length);
    const decoder1251 = new TextDecoder('windows-1251');
    const decoded1251 = decoder1251.decode(bytes).replace(/\0/g, '').replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();

    // Check if the result looks like valid Cyrillic
    if (/[А-Яа-я]/.test(decoded1251) && !/[À-ßà-ÿЁёЮЫЮФШЭ]/.test(decoded1251)) {
      return decoded1251;
    }
  } catch (error) {
    // ignore byte reading errors
  }

  // 2. Fallback: Check if dicom-parser's string looks like Cyrillic moji-bake and try character code extraction
  const hasCyrillicMojiBake = /[À-ßà-ÿЁёЮЫЮФШЭ]/.test(cleaned);
  if (hasCyrillicMojiBake) {
    try {
      const bytes = new Uint8Array(cleaned.length);
      for (let i = 0; i < cleaned.length; i++) {
        bytes[i] = cleaned.charCodeAt(i) & 0xFF;
      }

      const decoder = new TextDecoder('windows-1251');
      const decoded = decoder.decode(bytes);

      if (/[А-Яа-я]/.test(decoded)) {
        return decoded.trim();
      }
    } catch {
      // Fallback to original
    }
  }

  return cleaned;
}

interface ParsedFrameInfo {
  buffer: ArrayBuffer;
  dataSet: DataSet;
  isCompressed: boolean;
  isLosslessJPEG: boolean;
  littleEndian: boolean;
  requiresRescale: boolean;
  slope: number;
  intercept: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  signed: boolean;
  pixelElement: Element;
  projection: number;
  rows: number;
  columns: number;
  bytesPerPixel: number;
  numberOfFrames: number;
  sourceFrameIndex: number; // for multiframe
  origin: [number, number, number];
  volumeInfo: any;
}

// Extract metadata and prepare for decoding
function extractVolumeInfo(
  buffer: ArrayBuffer,
  sourceName: string,
  parsedDataSet?: DataSet,
): ParsedFrameInfo[] {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 132 || bytes[128] !== 0x44 || bytes[129] !== 0x49 ||
      bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
    throw new Error('Файл не содержит сигнатуру DICM в позиции 128 и не распознан как Part 10 DICOM.');
  }

  const dataSet = parsedDataSet ?? parseDicom(bytes);
  if (dataSet.string(MEDIA_STORAGE_SOP_CLASS_TAG)?.trim() === DICOM_DIRECTORY_STORAGE_UID) {
    throw new Error('DICOMDIR — это служебный индекс папки, а не изображение. Выберите папку целиком, включая вложенную папку IMAGES.');
  }
  const transferSyntax = dataSet.string('x00020010')?.trim();
  const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
  const isBaselineJPEG = transferSyntax === '1.2.840.10008.1.2.4.50';
  const isLosslessJPEG = transferSyntax === '1.2.840.10008.1.2.4.57' || transferSyntax === '1.2.840.10008.1.2.4.70';
  const isCompressed = isBaselineJPEG || isLosslessJPEG;

  if (!transferSyntax || !littleEndian || ![
    '1.2.840.10008.1.2',
    '1.2.840.10008.1.2.1',
    '1.2.840.10008.1.2.4.50',
    '1.2.840.10008.1.2.4.57',
    '1.2.840.10008.1.2.4.70'
  ].includes(transferSyntax)) {
    throw new Error(`Transfer Syntax ${transferSyntax ?? 'неизвестен'} не поддерживается. Нужен несжатый или JPEG Baseline/Lossless.`);
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
  if (!pixelElement) {
    throw new Error('Pixel Data отсутствует.');
  }

  const voxelCount = rows * columns * numberOfFrames;
  const bytesPerPixel = bitsAllocated / 8;
  const expectedPixelBytes = voxelCount * bytesPerPixel;

  if (!isCompressed && (!Number.isSafeInteger(voxelCount) ||
      (pixelElement.length !== expectedPixelBytes &&
        !(expectedPixelBytes % 2 === 1 && pixelElement.length === expectedPixelBytes + 1)) ||
      pixelElement.dataOffset + expectedPixelBytes > bytes.byteLength)) {
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

  const signed = pixelRepresentation === 1;

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

  const patientName = decodeString(dataSet, 'x00100010');
  const patientId = decodeString(dataSet, 'x00100020');
  const studyDateRaw = dataSet.string('x00080020');
  const studyDate = studyDateRaw?.length === 8
    ? `${studyDateRaw.slice(0,4)}-${studyDateRaw.slice(4,6)}-${studyDateRaw.slice(6,8)}`
    : studyDateRaw;
  const studyDescription = decodeString(dataSet, 'x00081030');
  const seriesDescription = decodeString(dataSet, 'x0008103e');
  const manufacturer = decodeString(dataSet, 'x00080070');

  const volumeInfo = {
    metadata: frameMetadata,
    dimensions: [columns, rows, numberOfFrames],
    spacing: [pixelSpacing[1], pixelSpacing[0], spacingZ],
    direction: new Float32Array([...xAxis, ...yAxis, ...normal]),
    sliceThickness: Number.isFinite(sliceThickness) && sliceThickness > 0 ? sliceThickness : spacingZ,
    numberOfFrames,
    windowCenter: Number.isFinite(windowCenter) ? windowCenter : 40,
    windowWidth: Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 400,
    isMonochrome1: photometricInterpretation === 'MONOCHROME1',
    modality: dataSet.string('x00080060')?.trim() ?? 'CT',
    sourceName,
    patientName,
    patientId,
    studyDate,
    studyDescription,
    seriesDescription,
    manufacturer,
  };

  return descriptors.map((desc) => {
    const frame = frameFunctionalGroup(dataSet, PER_FRAME_GROUPS_TAG, desc.index);
    const transform = firstItem(frame, PIXEL_VALUE_TRANSFORM_TAG) ??
      firstItem(shared, PIXEL_VALUE_TRANSFORM_TAG);
    const slope = Number.parseFloat(transform?.string('x00281053') ?? dataSet.string('x00281053') ?? '1');
    const intercept = Number.parseFloat(transform?.string('x00281052') ?? dataSet.string('x00281052') ?? '0');
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
      throw new Error('Некорректные Rescale Slope/Intercept.');
    }

    return {
      buffer,
      dataSet,
      isCompressed,
      isLosslessJPEG,
      littleEndian,
      requiresRescale: slope !== 1 || intercept !== 0,
      slope,
      intercept,
      bitsAllocated,
      bitsStored,
      highBit,
      pixelRepresentation,
      signed,
      pixelElement,
      projection: desc.projection ?? 0,
      rows,
      columns,
      bytesPerPixel,
      numberOfFrames,
      sourceFrameIndex: desc.index,
      origin: (desc.position ?? rootPosition ?? [0, 0, 0]).slice(0, 3) as [number, number, number],
      volumeInfo,
    };
  });
}

function decodeFrame(frame: ParsedFrameInfo, scalarData: Float32Array | Uint8Array | Uint16Array | Int16Array, outputFrameIndex: number) {
  const {
    buffer, isCompressed, isLosslessJPEG, littleEndian, requiresRescale, slope, intercept,
    bitsAllocated, bitsStored, highBit, pixelRepresentation, signed, pixelElement,
    rows, columns, bytesPerPixel, sourceFrameIndex,
  } = frame;

  const view = new DataView(buffer);
  const voxelsPerFrame = rows * columns;
  const destinationOffset = outputFrameIndex * voxelsPerFrame;

  if (isCompressed && pixelElement.encapsulatedPixelData) {
    const fragments = pixelElement.fragments?.filter(f => f.length > 0) || [];
    if (sourceFrameIndex >= fragments.length) {
      throw new Error(`Недостаточно фрагментов сжатых данных. Кадр: ${sourceFrameIndex}, Фрагментов: ${fragments.length}`);
    }

    const fragment = fragments[sourceFrameIndex];
    const compressedBytes = new Uint8Array(buffer, pixelElement.dataOffset + fragment.offset, fragment.length);

    let framePixels: Uint8Array | Uint16Array | Int16Array;
    if (isLosslessJPEG) {
      const decoder = new JpegLosslessDecoder();
      const decompressed = decoder.decode(compressedBytes.buffer, compressedBytes.byteOffset, compressedBytes.byteLength);
      if (bitsAllocated === 8) {
        framePixels = new Uint8Array(decompressed.buffer, decompressed.byteOffset, voxelsPerFrame);
      } else if (signed) {
        framePixels = new Int16Array(decompressed.buffer, decompressed.byteOffset, voxelsPerFrame);
      } else {
        framePixels = new Uint16Array(decompressed.buffer, decompressed.byteOffset, voxelsPerFrame);
      }
    } else {
      const decoded = decodeJpegBaseline(compressedBytes, { useTArray: true, colorTransform: false });
      framePixels = new Uint8Array(voxelsPerFrame);
      if (decoded.data.length === voxelsPerFrame) {
        framePixels.set(decoded.data);
      } else if (decoded.data.length === voxelsPerFrame * 4) {
        for (let i = 0; i < voxelsPerFrame; i++) {
          framePixels[i] = decoded.data[i * 4];
        }
      } else {
        throw new Error('Неожиданный размер данных после JPEG распаковки.');
      }
    }

    for (let voxel = 0; voxel < voxelsPerFrame; voxel++) {
      const raw = framePixels[voxel];
      const value = normalizePixel(raw, bitsStored, highBit, pixelRepresentation);
      scalarData[destinationOffset + voxel] = requiresRescale ? value * slope + intercept : value;
    }
  } else {
    const sourceOffset = pixelElement.dataOffset + sourceFrameIndex * voxelsPerFrame * bytesPerPixel;
    for (let voxel = 0; voxel < voxelsPerFrame; voxel++) {
      const raw = readPixelValue(view, sourceOffset + voxel * bytesPerPixel, bitsAllocated, littleEndian);
      const value = normalizePixel(raw, bitsStored, highBit, pixelRepresentation);
      scalarData[destinationOffset + voxel] = requiresRescale ? value * slope + intercept : value;
    }
  }
}

async function parseFiles(buffers: ArrayBuffer[], sourceName: string): Promise<SerializedDicomVolume> {
  if (buffers.length === 0) {
    throw new Error('Не найдены DICOM-файлы для загрузки.');
  }

  const allFrames: ParsedFrameInfo[] = [];

  // Pass 1: Extract metadata from all files and buffers
  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength < 132 || bytes[128] !== 0x44 || bytes[129] !== 0x49 ||
        bytes[130] !== 0x43 || bytes[131] !== 0x4d) {
      if (buffers.length === 1) {
        throw new Error('Файл не содержит сигнатуру DICM в позиции 128 и не распознан как Part 10 DICOM.');
      }
      continue; // Skip invalid files in a folder
    }

    const dataSet = parseDicom(bytes);
    if (dataSet.string(MEDIA_STORAGE_SOP_CLASS_TAG)?.trim() === DICOM_DIRECTORY_STORAGE_UID) {
      continue;
    }

    const framesInfo = extractVolumeInfo(buffer, sourceName, dataSet);
    allFrames.push(...framesInfo);
  }

  if (allFrames.length === 0) {
    throw new Error('Не найдено корректных файлов изображений.');
  }

  const firstFrame = allFrames[0];
  const requiredMetadata = [
    'SeriesInstanceUID',
    'FrameOfReferenceUID',
    'Rows',
    'Columns',
    'BitsAllocated',
    'BitsStored',
    'SamplesPerPixel',
    'HighBit',
    'PhotometricInterpretation',
    'PixelRepresentation',
    'Modality',
    'PixelSpacing',
    'ImageOrientationPatient',
  ] as const;

  // Validate consistency across all frames
  for (const frame of allFrames) {
    for (const key of requiredMetadata) {
      const firstValue = firstFrame.volumeInfo.metadata[key];
      const nextValue = frame.volumeInfo.metadata[key];
      if (Array.isArray(firstValue) && Array.isArray(nextValue)) {
        if (firstValue.length !== nextValue.length ||
            firstValue.some((value, index) =>
              typeof value !== 'number' || typeof nextValue[index] !== 'number' ||
              Math.abs(value - nextValue[index]!) > 0.0001)) {
          throw new Error('Найдены кадры/файлы с разными геометрией или параметрами пикселей.');
        }
      } else if (firstValue !== nextValue) {
        throw new Error('В папке найдены разные DICOM-серии. Выберите только одну серию.');
      }
    }
  }

  // Sort all frames by projection
  allFrames.sort((a, b) => a.projection - b.projection);

  // Recalculate spacing Z if there are multiple frames
  let spacingZ = firstFrame.volumeInfo.spacing[2];
  if (allFrames.length > 1) {
    const distances = allFrames.slice(1).map((item, index) => item.projection - allFrames[index].projection);
    if (distances.some((distance) => distance <= 0.001)) {
      throw new Error('В серии есть срезы с совпадающими позициями; корректный MPR-объем построить нельзя.');
    }
    spacingZ = distances.length > 0 ? median(distances) : spacingZ;
    if (!Number.isFinite(spacingZ) || spacingZ <= 0) {
      throw new Error('Не удалось определить положительный шаг между срезами серии.');
    }
    if (distances.some((distance) => Math.abs(distance - spacingZ) > Math.max(0.02, spacingZ * 0.02))) {
      throw new Error('Позиции срезов имеют неравномерный шаг; построение регулярного MPR-объема небезопасно.');
    }
  }

  // Determine scalar type and allocate one big array
  const requiresRescale = allFrames.some(f => f.requiresRescale);
  let scalarType: 'Float32Array' | 'Uint8Array' | 'Int16Array' | 'Uint16Array' = 'Float32Array';
  if (!requiresRescale) {
    if (firstFrame.bitsAllocated === 8) {
      scalarType = firstFrame.signed ? 'Float32Array' : 'Uint8Array';
       // Fallback for unsupported types if needed, but our worker supports Uint8Array.
    } else {
      scalarType = firstFrame.signed ? 'Int16Array' : 'Uint16Array';
    }
  }

  const voxelCountPerSlice = firstFrame.rows * firstFrame.columns;
  const totalVoxels = voxelCountPerSlice * allFrames.length;

  const scalarData = scalarType === 'Float32Array' ? new Float32Array(totalVoxels) :
                     scalarType === 'Uint8Array' ? new Uint8Array(totalVoxels) :
                     scalarType === 'Int16Array' ? new Int16Array(totalVoxels) :
                     new Uint16Array(totalVoxels);

  // Pass 2: Decode frames directly into the allocated array
  for (let i = 0; i < allFrames.length; i++) {
    decodeFrame(allFrames[i], scalarData, i);
    // Explicitly allow GC of buffer reference if this was the last frame from this buffer
    // For single multi-frame file, this buffer is used multiple times, but GC will collect it later.
    // For folder of files, the file buffer is used only once.
  }

  return {
    scalarData: scalarData.buffer,
    scalarType,
    metadata: firstFrame.volumeInfo.metadata,
    dimensions: [firstFrame.columns, firstFrame.rows, allFrames.length],
    spacing: [firstFrame.volumeInfo.spacing[0], firstFrame.volumeInfo.spacing[1], spacingZ],
    origin: allFrames[0].origin,
    direction: firstFrame.volumeInfo.direction,
    sliceThickness: firstFrame.volumeInfo.sliceThickness,
    numberOfFrames: allFrames.length,
    windowCenter: firstFrame.volumeInfo.windowCenter,
    windowWidth: firstFrame.volumeInfo.windowWidth,
    isMonochrome1: firstFrame.volumeInfo.isMonochrome1,
    modality: firstFrame.volumeInfo.modality,
    sourceName,
    patientName: firstFrame.volumeInfo.patientName,
    patientId: firstFrame.volumeInfo.patientId,
    studyDate: firstFrame.volumeInfo.studyDate,
    studyDescription: firstFrame.volumeInfo.studyDescription,
    seriesDescription: firstFrame.volumeInfo.seriesDescription,
    manufacturer: firstFrame.volumeInfo.manufacturer,
  };
}

const fileBuffers: ArrayBuffer[] = [];

workerScope.onmessage = async (event: MessageEvent<any>) => {
  try {
    if (event.data.type === 'file') {
      fileBuffers.push(event.data.buffer);
    } else if (event.data.type === 'process') {
      const result = await parseFiles(fileBuffers, event.data.sourceName);
      workerScope.postMessage(result, [result.scalarData]);
      fileBuffers.length = 0; // Clear the buffers
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обработать DICOM-файл.';
    workerScope.postMessage({ error: message });
  }
};

export {};
