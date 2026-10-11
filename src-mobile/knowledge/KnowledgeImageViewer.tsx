import { MobileSheet } from "../ui/MobileSheet";
import { useEffect, useRef, useState } from "react";
import { KnowledgeImageCanvas, type ImageCanvasHandle } from "./KnowledgeImageCanvas";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeImageCanvas.module.css";
export function KnowledgeImageViewer({ image, active, onClose }: {
  image: { src: string; alt: string } | null; active: boolean; onClose: () => void;
}) {
  const canvas = useRef<ImageCanvasHandle>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image?.src]);
  return <MobileSheet open={!!image && active} title="查看图片" onClose={onClose} contentClassName={styles.imageSheet} bodyClassName={styles.body} actions={<div className={styles.tools}>
    <button className={ui.textButton} aria-label="缩小图片" disabled={failed} onClick={() => canvas.current?.zoom(1 / 1.5)}>缩小</button>
    <button className={ui.textButton} aria-label="放大图片" disabled={failed} onClick={() => canvas.current?.zoom(1.5)}>放大</button>
    <button className={ui.textButton} disabled={failed} onClick={() => canvas.current?.reset()}>适应</button>
  </div>}>
    {image && <KnowledgeImageCanvas ref={canvas} key={image.src} src={image.src} alt={image.alt} onFailure={setFailed} />}
  </MobileSheet>;
}
