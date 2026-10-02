// Camera-mapped real-UI plate. Renders the captured product screenshot
// under a camera transform inside a view rect (full frame for 16:9, a
// window for 9:16 / 1:1). Children render in PLATE space — same
// transform, so cursors stick to UI points while the camera moves;
// a context keeps on-screen sizes constant under zoom.
import React, { createContext, useContext } from 'react';
import { Img, interpolate, useCurrentFrame, Easing } from 'remotion';
import { plateTransform, type Cam, lerpCam, easeInOutCubic } from '../kit';

export const ScreenScale = createContext(1);
export const useScreenScale = () => useContext(ScreenScale);

type View = { x: number; y: number; w: number; h: number };

type Props = {
  src: string;
  view: View;
  camFrom: Cam;
  camTo: Cam;
  camAt?: [number, number]; // frame window of the camera move; holds outside it
  easing?: (t: number) => number;
  crossfadeTo?: string; // second plate, crossfaded in at crossfadeAt
  crossfadeAt?: number;
  crossfadeDur?: number;
  children?: React.ReactNode; // plate-space overlays (cursor, covers)
  style?: React.CSSProperties;
};

export const CameraPlate: React.FC<Props> = ({
  src, view, camFrom, camTo, camAt = [0, 30], easing = easeInOutCubic,
  crossfadeTo, crossfadeAt = 0, crossfadeDur = 12, children, style,
}) => {
  const frame = useCurrentFrame();

  const t = interpolate(frame, [camAt[0], camAt[1]], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const cam = lerpCam(camFrom, camTo, easing(t));
  const tf = plateTransform(cam, view);
  const s = (tf.transform.match(/scale\(([\d.]+)\)/) as RegExpMatchArray | null)
    ? Number((tf.transform.match(/scale\(([\d.]+)\)/) as RegExpMatchArray)[1])
    : 1;

  const a = crossfadeTo
    ? interpolate(frame, [crossfadeAt, crossfadeAt + crossfadeDur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) })
    : 1;

  return (
    <div style={{ position: 'absolute', left: view.x, top: view.y, width: view.w, height: view.h, overflow: 'hidden', background: '#000', ...style }}>
      <div style={{ position: 'absolute', ...tf }}>
        <Img src={src} style={{ width: 1600, height: 1000, display: 'block', opacity: a }} />
        {crossfadeTo ? (
          <Img src={crossfadeTo} style={{ width: 1600, height: 1000, display: 'block', position: 'absolute', left: 0, top: 0, opacity: 1 - a }} />
        ) : null}
        <ScreenScale.Provider value={s}>{children}</ScreenScale.Provider>
      </div>
    </div>
  );
};
