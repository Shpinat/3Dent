import type { DicomdirPatient } from '../utils/dicomdirParser';

export interface DataSelectionItem {
  id: string;
  type: 'dicom_series' | 'image_2d' | 'mesh_3d';
  label: string;
  subLabel?: string;
  files: File[];
}

interface Props {
  items: DataSelectionItem[];
  dicomdir?: DicomdirPatient[];
  onSelect: (item: DataSelectionItem) => void;
  onCancel: () => void;
}

export function DataSelectionModal({ items, dicomdir, onSelect, onCancel }: Props) {
  return (
    <div className="modal-overlay">
      <div className="modal-card">
        <header className="modal-header">
          <h2>Выберите данные для загрузки</h2>
          <button className="modal-close" onClick={onCancel}>×</button>
        </header>
        <div className="modal-content">
          {dicomdir && dicomdir.length > 0 && (
            <div className="dicomdir-section">
              <h3>DICOMDIR Индекс</h3>
              {dicomdir.map(patient => (
                <div key={patient.id} className="patient-group">
                  <h4>{patient.name} ({patient.id})</h4>
                  {patient.studies.map(study => (
                    <div key={study.uid} className="study-group">
                      <h5>{study.description} [{study.date}]</h5>
                      <ul className="series-list">
                        {study.series.map(series => {
                          // Find corresponding item
                          const mappedItem = items.find(i => i.id === series.uid) || items.find(i => i.type === 'dicom_series');
                          if (!mappedItem) return null;
                          return (
                            <li key={series.uid} onClick={() => onSelect(mappedItem)} className="series-item">
                              <span className="modality-badge">{series.modality}</span>
                              <div className="series-info">
                                <strong>{series.description || 'Без описания'}</strong>
                                <span>{mappedItem.files.length} снимков</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {items.filter(i => !dicomdir || i.type !== 'dicom_series').length > 0 && (
            <div className="other-files-section">
              <h3>Дополнительные файлы</h3>
              <ul className="series-list">
                {items.filter(i => !dicomdir || i.type !== 'dicom_series').map(item => (
                  <li key={item.id} onClick={() => onSelect(item)} className="series-item">
                    <span className="modality-badge">
                      {item.type === 'image_2d' ? '2D' : item.type === 'mesh_3d' ? '3D' : 'DICOM'}
                    </span>
                    <div className="series-info">
                      <strong>{item.label}</strong>
                      {item.subLabel && <span>{item.subLabel}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
