import './fonts.css';
import { registerRoot, Composition } from 'remotion';
import { Master30 } from './Master30';
import { Cutdown15 } from './Cutdown15';

const FORMATS = [
  { id: '16x9', w: 1920, h: 1080 },
  { id: '9x16', w: 1080, h: 1920 },
  { id: '1x1', w: 1080, h: 1080 },
] as const;

registerRoot(() => (
  <>
    {FORMATS.map((f) => (
      <Composition
        key={`m-${f.id}`}
        id={`Master30-${f.id}`}
        component={Master30}
        defaultProps={{ format: f.id }}
        durationInFrames={30 * 30}
        fps={30}
        width={f.w}
        height={f.h}
      />
    ))}
    {FORMATS.map((f) => (
      <Composition
        key={`c-${f.id}`}
        id={`Cutdown15-${f.id}`}
        component={Cutdown15}
        defaultProps={{ format: f.id }}
        durationInFrames={15 * 30}
        fps={30}
        width={f.w}
        height={f.h}
      />
    ))}
  </>
));
