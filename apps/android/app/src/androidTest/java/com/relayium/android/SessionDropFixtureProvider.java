package com.relayium.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Standalone test-APK UID: no Kotlin or target-APK dependency is available here. */
public final class SessionDropFixtureProvider extends ContentProvider {
    public static final Uri URI = Uri.parse("content://org.relayium.android.dropfixture/proof");
    public static final byte[] BODY = "Android external file drop — 你好\n".getBytes(StandardCharsets.UTF_8);

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection,
            String[] selectionArgs, String sortOrder) {
        if (!URI.equals(uri)) throw new SecurityException("unknown fixture");
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[] {"drop-proof.txt", BODY.length});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!URI.equals(uri) || !"r".equals(mode)) throw new SecurityException("read only");
        File file = new File(getContext().getCacheDir(), "drop-proof.txt");
        if (!file.exists()) {
            try (FileOutputStream output = new FileOutputStream(file)) { output.write(BODY); }
            catch (IOException e) { throw new FileNotFoundException("fixture unavailable"); }
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new SecurityException("read only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new SecurityException("read only");
    }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new SecurityException("read only"); }
}
