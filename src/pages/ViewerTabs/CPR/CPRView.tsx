import React, { useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { useAppContext } from '../../../context/AppContext';
import { setupToolGroup, TOOL_GROUP_ID, syncWindowLevel } from '../../../lib/cornerstone/tools';

interface CPRViewProps {
  windowWidth: number;
  windowCenter: number;
  activeTool: string;
}

const RENDERING_ENGINE_ID = 'cpr-rendering-engine';
const VOLUME_ID = 'cornerstoneStreamingImageVolume:mpr-volume'; // Re-use the volume from MPR
const VIEWPORT_IDS = {
  AXIAL: 'cpr-axial-viewport',
  PANORAMA: 'cpr-panorama-viewport',
};

// Tool used to draw the spline for CPR.
const SPLINE_TOOL_NAME = cornerstoneTools.SplineROITool.toolName;

export const CPRView: React.FC<CPRViewProps> = ({ windowWidth, windowCenter, activeTool }) => {
  const { studies, activeStudyId } = useAppContext();
  const activeStudy = studies.find(s => s.id === activeStudyId);

  const axialRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<HTMLDivElement>(null);

  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!activeStudy || !axialRef.current || !panoramaRef.current) return;

    let renderingEngine: cornerstone.RenderingEngine;

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
          // Note: In a true CPR implementation, the panorama viewport might be of a specific CPR type
          // or a standard orthogonal viewport that looks at a generated volume.
          // For now, we set it up as a placeholder orthogonal viewport.
          {
            viewportId: VIEWPORT_IDS.PANORAMA,
            type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
            element: panoramaRef.current!,
            defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.CORONAL },
          },
        ];

        renderingEngine.setViewports(viewports);

        // We assume the volume is already cached from the MPR view, if not we would need to load it here.
        // For robustness, we check if it's cached, otherwise this logic could be lifted to a parent.
        const cachedVolume = cornerstone.cache.getVolume(VOLUME_ID);
        if (cachedVolume) {
            await cornerstone.setVolumesForViewports(
              renderingEngine,
              [{ volumeId: VOLUME_ID }],
              [VIEWPORT_IDS.AXIAL] // Usually you only show the volume in the axial for drawing
            );
        }

        const toolGroup = setupToolGroup();
        if (toolGroup) {
           toolGroup.addViewport(VIEWPORT_IDS.AXIAL, RENDERING_ENGINE_ID);

           // Ensure Spline tool is added for drawing the curve
           if (!toolGroup.hasTool(SPLINE_TOOL_NAME)) {
              cornerstoneTools.addTool(cornerstoneTools.SplineROITool);
              toolGroup.addTool(SPLINE_TOOL_NAME);
           }
        }

        renderingEngine.renderViewports([VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.PANORAMA]);
        setIsLoaded(true);

      } catch (e) {
        console.error("Error setting up CPR:", e);
      }
    };

    setup();

    return () => {
      if (renderingEngine) {
         renderingEngine.destroy();
      }
      const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
      if (toolGroup) {
         toolGroup.removeViewports(RENDERING_ENGINE_ID);
      }
    };
  }, [activeStudy]);

  useEffect(() => {
    if (isLoaded) {
      syncWindowLevel(RENDERING_ENGINE_ID, [VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.PANORAMA], windowWidth, windowCenter);
    }
  }, [windowWidth, windowCenter, isLoaded]);

  useEffect(() => {
     if (!isLoaded) return;
     const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
     if (toolGroup) {
         // Temporarily hardcode Spline for CPR if needed, or follow activeTool
         if (activeTool === 'Spline') {
            toolGroup.setToolActive(SPLINE_TOOL_NAME, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
         } else {
            // Revert to crosshairs or pan
            toolGroup.setToolActive(cornerstoneTools.PanTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }] });
         }
     }
  }, [activeTool, isLoaded]);

  return (
    <div className="flex w-full h-full p-2 gap-2 bg-black">
      <div className="flex-1 flex flex-col gap-2 relative rounded-lg border border-border overflow-hidden bg-black">
        <div className="absolute top-2 left-2 z-10 bg-black/50 text-white px-2 py-1 rounded text-xs">
          1. Нарисуйте кривую (сплайн) челюсти на аксиальном срезе
        </div>
        <div ref={axialRef} className="flex-1 h-full w-full" onContextMenu={e => e.preventDefault()} />
      </div>
      <div className="flex-1 flex flex-col gap-2 relative rounded-lg border border-border overflow-hidden bg-black">
        <div className="absolute top-2 left-2 z-10 bg-black/50 text-white px-2 py-1 rounded text-xs">
          2. Результат (Развернутая панорама)
        </div>
        <div ref={panoramaRef} className="flex-1 h-full w-full flex items-center justify-center border-2 border-dashed border-muted-foreground/30 m-4">
           {/* In a real implementation, the generated CPR texture/volume would be rendered here */}
           <span className="text-muted-foreground font-mono text-sm">Waiting for CPR Curve...</span>
        </div>
      </div>
    </div>
  );
};
