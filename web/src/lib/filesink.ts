export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function createFileSink(name: string, _size: number): Promise<FileSink> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{
      createWritable: () => Promise<{
        write: (d: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  }).showSaveFilePicker;

  if (picker) {
    const handle = await picker({ suggestedName: name });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
    };
  }

  // Fallback: buffer in memory, download as a Blob on close.
  console.warn(
    "File System Access API unavailable; buffering in memory. Large files may fail in this browser.",
  );
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => { parts.push(chunk); },
    close: async () => {
      const blob = new Blob(parts as BlobPart[]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
