import React, { useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { useAppContext } from '../../../context/AppContext';
import { setupToolGroup, TOOL_GROUP_ID, syncWindowLevel } from '../../../lib/cornerstone/tools';

interface MPRViewProps {
  windowWidth: number;
  windowCenter: number;
  slabThickness: number;
  activeTool: string;
}

const RENDERING_ENGINE_ID = 'mpr-rendering-engine';
const VOLUME_ID = 'cornerstoneStreamingImageVolume:mpr-volume';
const VIEWPORT_IDS = {
  AXIAL: 'axial-viewport',
  SAGITTAL: 'sagittal-viewport',
  CORONAL: 'coronal-viewport',
};

export const MPRView: React.FC<MPRViewProps> = ({ windowWidth, windowCenter, slabThickness, activeTool }) => {
  const { studies, activeStudyId } = useAppContext();
  const activeStudy = studies.find(s => s.id === activeStudyId);

  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);

  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!activeStudy || !axialRef.current || !sagittalRef.current || !coronalRef.current) return;

    let renderingEngine: cornerstone.RenderingEngine;
    let volume: any;

    const setup = async () => {
      try {
        renderingEngine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);

        const viewports = [
          {
            viewportId: VIEWPORT_IDS.AXIAL,
            type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
            element: axialRef.current!,
            defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.AXIAL },
          },
          {
            viewportId: VIEWPORT_IDS.SAGITTAL,
            type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
            element: sagittalRef.current!,
            defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.SAGITTAL },
          },
          {
            viewportId: VIEWPORT_IDS.CORONAL,
            type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
            element: coronalRef.current!,
            defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.CORONAL },
          },
        ];

        renderingEngine.setViewports(viewports);

        const imageIds = activeStudy.files.map(f => f.imageId);

        volume = await cornerstone.volumeLoader.createAndCacheVolume(VOLUME_ID, { imageIds });
        volume.load();

        await cornerstone.setVolumesForViewports(
          renderingEngine,
          [{ volumeId: VOLUME_ID }],
          [VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL]
        );

        const toolGroup = setupToolGroup();
        if (toolGroup) {
           toolGroup.addViewport(VIEWPORT_IDS.AXIAL, RENDERING_ENGINE_ID);
           toolGroup.addViewport(VIEWPORT_IDS.SAGITTAL, RENDERING_ENGINE_ID);
           toolGroup.addViewport(VIEWPORT_IDS.CORONAL, RENDERING_ENGINE_ID);
        }

        renderingEngine.renderViewports([VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL]);
        setIsLoaded(true);

      } catch (e) {
        console.error("Error setting up MPR:", e);
      }
    };

    setup();

    return () => {
      if (renderingEngine) {
         renderingEngine.destroy();
      }
      cornerstone.cache.removeVolumeLoadObject(VOLUME_ID);
      const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
      if (toolGroup) {
         toolGroup.removeViewports(RENDERING_ENGINE_ID);
      }
    };
  }, [activeStudy]);

  useEffect(() => {
    if (isLoaded) {
      syncWindowLevel(RENDERING_ENGINE_ID, [VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL], windowWidth, windowCenter);
    }
  }, [windowWidth, windowCenter, isLoaded]);

  useEffect(() => {
    if (isLoaded && slabThickness) {
      const renderingEngine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
      if (renderingEngine) {
        [VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL].forEach(vpId => {
          const vp = renderingEngine.getViewport(vpId) as cornerstone.Types.IVolumeViewport;
          if (vp && vp.setBlendMode) {
             vp.setBlendMode(cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
             vp.setSlabThickness(slabThickness);
          }
        });
        renderingEngine.render();
      }
    }
  }, [slabThickness, isLoaded]);

  useEffect(() => {
     if (!isLoaded) return;
     const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
     if (toolGroup) {
         if (activeTool === 'Crosshairs') {
            toolGroup.setToolActive(cornerstoneTools.CrosshairsTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
            toolGroup.setToolPassive(cornerstoneTools.LengthTool.toolName);
         } else if (activeTool === 'Length') {
            toolGroup.setToolActive(cornerstoneTools.LengthTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
            toolGroup.setToolPassive(cornerstoneTools.CrosshairsTool.toolName);
         }
     }
  }, [activeTool, isLoaded]);

  return (
    <div className="flex w-full h-full p-2 gap-2 bg-black">
      <div className="flex-1 flex flex-col gap-2">
        <div className="flex-1 relative rounded-lg border border-border overflow-hidden bg-black flex">
           <div ref={axialRef} className="flex-1 h-full w-full" onContextMenu={e => e.preventDefault()} />
           <div className="w-6 h-full bg-secondary flex flex-col items-center justify-center border-l border-border shrink-0">
             <input type="range" className="w-full h-4 rotate-90 origin-center cursor-pointer appearance-none bg-background rounded" />
           </div>
           <div className="absolute top-2 left-2 text-white text-xs font-mono drop-shadow-md pointer-events-none">Axial</div>
        </div>
      </div>
      <div className="flex-1 flex flex-col gap-2">
        <div className="flex-1 relative rounded-lg border border-border overflow-hidden bg-black flex">
           <div ref={coronalRef} className="flex-1 h-full w-full" onContextMenu={e => e.preventDefault()} />
           <div className="w-6 h-full bg-secondary flex flex-col items-center justify-center border-l border-border shrink-0">
             <input type="range" className="w-full h-4 rotate-90 origin-center cursor-pointer appearance-none bg-background rounded" />
           </div>
           <div className="absolute top-2 left-2 text-white text-xs font-mono drop-shadow-md pointer-events-none">Coronal</div>
        </div>
        <div className="flex-1 relative rounded-lg border border-border overflow-hidden bg-black flex">
           <div ref={sagittalRef} className="flex-1 h-full w-full" onContextMenu={e => e.preventDefault()} />
           <div className="w-6 h-full bg-secondary flex flex-col items-center justify-center border-l border-border shrink-0">
             <input type="range" className="w-full h-4 rotate-90 origin-center cursor-pointer appearance-none bg-background rounded" />
           </div>
           <div className="absolute top-2 left-2 text-white text-xs font-mono drop-shadow-md pointer-events-none">Sagittal</div>
        </div>
      </div>
    </div>
  );
};
