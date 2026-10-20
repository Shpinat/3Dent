import React, { createContext, useContext, useState, type ReactNode } from 'react';
import { v4 as uuidv4 } from 'uuid';

export interface DicomFile {
  file: File;
  imageId: string;
}

export interface Study {
  id: string;
  name: string;
  dateAdded: Date;
  files: DicomFile[];
  patientName?: string;
  studyDate?: string;
  patientOrientation?: string;
}

interface AppContextType {
  studies: Study[];
  activeStudyId: string | null;
  addStudy: (name: string, files: DicomFile[], metadata?: any) => void;
  removeStudies: (ids: string[]) => void;
  setActiveStudy: (id: string | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [studies, setStudies] = useState<Study[]>([]);
  const [activeStudyId, setActiveStudyId] = useState<string | null>(null);

  const addStudy = (name: string, files: DicomFile[], metadata?: any) => {
    const newStudy: Study = {
      id: uuidv4(),
      name,
      dateAdded: new Date(),
      files,
      patientName: metadata?.patientName,
      studyDate: metadata?.studyDate,
      patientOrientation: metadata?.patientOrientation,
    };
    setStudies(prev => [...prev, newStudy]);
  };

  const removeStudies = (ids: string[]) => {
    setStudies(prev => prev.filter(s => !ids.includes(s.id)));
    if (activeStudyId && ids.includes(activeStudyId)) {
      setActiveStudyId(null);
    }
  };

  const setActiveStudy = (id: string | null) => {
    setActiveStudyId(id);
  };

  return (
    <AppContext.Provider value={{ studies, activeStudyId, addStudy, removeStudies, setActiveStudy }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

export default AppProvider;