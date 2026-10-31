package com.pocketcalc.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.widget.FrameLayout;

// Lets the user pick the calculation that opens Tele: typed on the keypad, then once more to confirm
public class LockSetupActivity extends Activity {
    private static final int MIN_KEYS = 3;

    private CalculatorView calculator;
    private String firstKeys;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        calculator = new CalculatorView(this);
        calculator.setListener(this::onKeys);
        root.addView(calculator);
        setContentView(root);

        if (LockStore.isOn(this)) askWhatToDo();
        else explain();
    }

    // Shown every time the lock is turned on or the calculation changed: forgetting it costs the login
    private void explain() {
        new AlertDialog.Builder(this)
            .setTitle("Read this before you continue")
            .setMessage("This app will open as a working calculator. Tele only appears when you type your own "
                + "calculation and press =, for example 5×6=. When you leave the app, Tele hides behind the "
                + "calculator again.\n\n"
                + "IMPORTANT: remember your calculation. It is not saved anywhere and nobody can recover it, "
                + "not even an admin.\n\n"
                + "If you forget it, the only way back in is to clear this app's data in Android settings. That "
                + "signs you out of Tele on this phone, and encrypted messages you can't restore from your key "
                + "backup are lost on this phone.")
            .setCancelable(false)
            .setPositiveButton("I understand", (dialog, which) -> startOver())
            .setNegativeButton("Cancel", (dialog, which) -> finish())
            .show();
    }

    private void askWhatToDo() {
        new AlertDialog.Builder(this)
            .setTitle("Calculator lock is on")
            .setItems(new CharSequence[] {"Change the calculation", "Turn off calculator lock"}, (dialog, which) -> {
                if (which == 0) {
                    explain();
                } else {
                    LockStore.turnOff(this);
                    setResult(RESULT_OK);
                    finish();
                }
            })
            .setNegativeButton("Cancel", (dialog, which) -> finish())
            .setOnCancelListener((dialog) -> finish())
            .show();
    }

    private void startOver() {
        firstKeys = null;
        calculator.clear();
        calculator.setHeader("Type the calculation that will open Tele, then press =");
    }

    private boolean onKeys(String keys) {
        if (firstKeys == null) {
            if (!isGoodChoice(keys)) {
                calculator.clear();
                calculator.showMessage("Use at least one operation, like 5×6");
                return true;
            }
            firstKeys = keys;
            calculator.clear();
            calculator.setHeader("Type it once more to confirm, then press =");
            return true;
        }
        if (!firstKeys.equals(keys)) {
            startOver();
            calculator.showMessage("They didn't match. Try again");
            return true;
        }
        LockStore.set(this, keys);
        setResult(RESULT_OK);
        calculator.clear();
        calculator.setHeader(null);
        new AlertDialog.Builder(this)
            .setTitle("Calculator lock is on")
            .setMessage("From now on, type " + keys + " and press = to open Tele.")
            .setPositiveButton("OK", (dialog, which) -> finish())
            .setOnCancelListener((dialog) -> finish())
            .show();
        return true;
    }

    private static boolean isGoodChoice(String keys) {
        if (keys.length() < MIN_KEYS) return false;
        for (int i = 1; i < keys.length(); i++) {
            char c = keys.charAt(i);
            if (Expression.isOperator(c) || c == '%') return true;
        }
        return false;
    }
}
