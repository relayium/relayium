package com.relayium.android;

import android.app.Activity;
import android.content.ClipData;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;

/** Real global drag from a separate app window, using only framework classes. */
public final class SessionDropSourceActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setWindowAnimations(0);
        Button button = new Button(this);
        button.setText("Drag fixture");
        button.setAllCaps(false);
        button.setOnLongClickListener(view -> {
            ClipData clip = getIntent().getBooleanExtra("textOnly", false)
                ? ClipData.newPlainText("test", "ordinary text")
                : ClipData.newUri(getContentResolver(), "fixture", SessionDropFixtureProvider.URI);
            int flags = View.DRAG_FLAG_GLOBAL;
            if (!getIntent().getBooleanExtra("noReadGrant", false)) flags |= View.DRAG_FLAG_GLOBAL_URI_READ;
            boolean started = view.startDragAndDrop(clip, new View.DragShadowBuilder(view), null, flags);
            android.util.Log.i("RelayiumDropFixture", "start=" + started + "; uid=" + android.os.Process.myUid()
                + "; uri=" + (clip.getItemAt(0).getUri() != null) + "; flags=" + flags);
            button.setText(started ? "Drag started" : "Drag refused");
            return started;
        });
        button.setOnDragListener((view, event) -> {
            if (event.getAction() == android.view.DragEvent.ACTION_DRAG_ENDED) {
                button.setText(event.getResult() ? "Drop accepted" : "Drop refused");
            }
            return event.getAction() == android.view.DragEvent.ACTION_DRAG_STARTED;
        });
        setContentView(button);
    }
}
