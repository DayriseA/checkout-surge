"use client";

import { buttonClassName } from "./control-styles";

export function SignalCsvDownload({ csv, fileName }: { csv: string; fileName: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button className={buttonClassName} onClick={download} type="button">
      Download CSV
    </button>
  );
}
