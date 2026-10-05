import type { ReactNode } from "react";
import styles from "./MobileUi.module.css";

export function MobilePage({
  title,
  subtitle,
  action,
  pageNotice,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  pageNotice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadCopy}>
          <h1 data-mobile-page-title>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        {action}
      </header>
      {pageNotice}
      {children}
    </div>
  );
}
