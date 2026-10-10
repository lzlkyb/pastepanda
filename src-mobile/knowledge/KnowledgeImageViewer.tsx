import { MobileSheet } from "../ui/MobileSheet";
import styles from "./KnowledgeMaintenance.module.css";
export function KnowledgeImageViewer({ image, active, onClose }: {
  image: { src: string; alt: string } | null; active: boolean; onClose: () => void;
}) {
  return <MobileSheet open={!!image && active} title="查看图片" onClose={onClose}>
    {image && <img className={styles.image} src={image.src} alt={image.alt || "笔记图片"} />}
  </MobileSheet>;
}
