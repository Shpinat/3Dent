import { parseDicom, type DataSet } from 'dicom-parser';

export interface DicomdirPatient {
  id: string;
  name: string;
  studies: DicomdirStudy[];
}

export interface DicomdirStudy {
  uid: string;
  date: string;
  description: string;
  series: DicomdirSeries[];
}

export interface DicomdirSeries {
  uid: string;
  modality: string;
  description: string;
  number: string;
  instances: string[]; // Paths to files
}

export async function parseDicomdir(file: File): Promise<DicomdirPatient[]> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let dataSet: DataSet;
  try {
    dataSet = parseDicom(bytes);
  } catch (e) {
    throw new Error('Failed to parse DICOMDIR file.');
  }

  const directoryRecordSequence = dataSet.elements['x00041220'];
  if (!directoryRecordSequence || !directoryRecordSequence.items) {
    throw new Error('No Directory Record Sequence found in DICOMDIR.');
  }

  const patients: DicomdirPatient[] = [];
  let currentPatient: DicomdirPatient | null = null;
  let currentStudy: DicomdirStudy | null = null;
  let currentSeries: DicomdirSeries | null = null;

  for (const item of directoryRecordSequence.items) {
    const ds = item.dataSet;
    if (!ds) continue;

    const recordType = ds.string('x00041430')?.trim();

    if (recordType === 'PATIENT') {
      currentPatient = {
        id: ds.string('x00100020') || 'Unknown ID',
        name: decodeDicomString(ds, 'x00100010') || 'Unknown Patient',
        studies: []
      };
      patients.push(currentPatient);
      currentStudy = null;
      currentSeries = null;
    } else if (recordType === 'STUDY') {
      if (!currentPatient) continue;
      currentStudy = {
        uid: ds.string('x0020000d') || '',
        date: ds.string('x00080020') || '',
        description: decodeDicomString(ds, 'x00081030') || 'Unknown Study',
        series: []
      };
      currentPatient.studies.push(currentStudy);
      currentSeries = null;
    } else if (recordType === 'SERIES') {
      if (!currentStudy) continue;
      currentSeries = {
        uid: ds.string('x0020000e') || '',
        modality: ds.string('x00080060') || '',
        description: decodeDicomString(ds, 'x0008103e') || 'Unknown Series',
        number: ds.string('x00200011') || '',
        instances: []
      };
      currentStudy.series.push(currentSeries);
    } else if (recordType === 'IMAGE') {
      if (!currentSeries) continue;
      // Extract File ID Components (x00041500)
      const fileIdSeq = ds.elements['x00041500'];
      if (fileIdSeq && fileIdSeq.length > 0) {
        // file ID is a multi-valued string separated by backslash
        const fileId = ds.string('x00041500');
        if (fileId) {
          currentSeries.instances.push(fileId.replace(/\\/g, '/'));
        }
      }
    }
  }

  return patients;
}

// Simple fallback decoder for DICOMDIR strings
function decodeDicomString(dataSet: DataSet, tag: string): string | undefined {
  const element = dataSet.elements[tag];
  if (!element || element.length === 0) return undefined;
  const rawString = dataSet.string(tag);
  if (!rawString) return undefined;

  let cleaned = rawString.replace(/\0/g, '').trim();
  cleaned = cleaned.replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    const bytes = new Uint8Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + element.dataOffset, element.length);
    const decoder = new TextDecoder('windows-1251');
    const decoded = decoder.decode(bytes).replace(/\0/g, '').replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
    if (/[А-Яа-яЁё]/.test(decoded)) return decoded;
  } catch(e) {}

  return cleaned;
}
