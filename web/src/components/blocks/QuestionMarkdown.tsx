// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { FilePathAwareMessageResponse } from "./ChatMarkdown";

/** Question display never changes the original IDs, values or submission payload. */
export function QuestionMarkdown({ children }: { children: string }) {
  return (
    <span
      className="min-w-0 break-words"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a,button"))
          event.stopPropagation();
      }}
    >
      <FilePathAwareMessageResponse
        mode="static"
        breaks
        className="inline text-inherit [&_p]:inline [&_p]:m-0 [&_a]:text-primary"
      >
        {children}
      </FilePathAwareMessageResponse>
    </span>
  );
}
