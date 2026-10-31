package com.pocketcalc.app;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

// A working calculator. Whatever is typed before "=" also goes to the listener, which may treat it as the
// calculation that opens Tele
final class CalculatorView extends LinearLayout {
    interface Listener {
        // True when the typed keys were used for something else and the calculator should not show a result
        boolean onEquals(String keys);
    }

    private static final String[][] KEYS = {
        {"AC", "( )", "%", "÷"},
        {"7", "8", "9", "×"},
        {"4", "5", "6", "−"},
        {"1", "2", "3", "+"},
        {"0", ".", "⌫", "="},
    };

    private final TextView headerView;
    private final TextView expressionView;
    private final TextView previewView;
    private final StringBuilder expression = new StringBuilder();
    private Listener listener;
    private boolean isShowingResult;

    CalculatorView(Context context) {
        super(context);
        setOrientation(VERTICAL);
        setBackgroundColor(color(R.color.calc_background));
        int pad = dp(16);
        setPadding(pad, pad, pad, pad);

        headerView = new TextView(context);
        headerView.setTextColor(color(R.color.calc_display_text));
        headerView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        headerView.setGravity(Gravity.CENTER);
        headerView.setVisibility(GONE);
        addView(headerView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        LinearLayout display = new LinearLayout(context);
        display.setOrientation(VERTICAL);
        display.setGravity(Gravity.BOTTOM | Gravity.END);
        addView(display, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1));

        expressionView = new TextView(context);
        expressionView.setTextColor(color(R.color.calc_display_text));
        expressionView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 48);
        expressionView.setGravity(Gravity.END);
        expressionView.setMaxLines(3);
        expressionView.setTextDirection(TEXT_DIRECTION_LTR);
        display.addView(expressionView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        previewView = new TextView(context);
        previewView.setTextColor(color(R.color.calc_preview_text));
        previewView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        previewView.setGravity(Gravity.END);
        previewView.setSingleLine(true);
        previewView.setTextDirection(TEXT_DIRECTION_LTR);
        LayoutParams previewParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        previewParams.bottomMargin = dp(16);
        display.addView(previewView, previewParams);

        LinearLayout keypad = new LinearLayout(context);
        keypad.setOrientation(VERTICAL);
        keypad.setLayoutDirection(LAYOUT_DIRECTION_LTR);
        addView(keypad, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1.5f));
        for (String[] row : KEYS) {
            LinearLayout rowView = new LinearLayout(context);
            keypad.addView(rowView, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1));
            for (String key : row) rowView.addView(makeKey(key), keyParams());
        }
        render();
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    void setHeader(CharSequence text) {
        headerView.setText(text);
        headerView.setVisibility(text == null ? GONE : VISIBLE);
    }

    void clear() {
        expression.setLength(0);
        isShowingResult = false;
        render();
    }

    void showMessage(CharSequence text) {
        previewView.setText(text);
    }

    private LayoutParams keyParams() {
        LayoutParams params = new LayoutParams(0, LayoutParams.MATCH_PARENT, 1);
        int margin = dp(5);
        params.setMargins(margin, margin, margin, margin);
        return params;
    }

    private View makeKey(String key) {
        TextView view = new TextView(getContext());
        view.setText(key);
        view.setGravity(Gravity.CENTER);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, key.length() > 1 && !key.equals("⌫") ? 22 : 28);
        view.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        boolean isEquals = key.equals("=");
        boolean isOperator = key.length() == 1 && Expression.isOperator(key.charAt(0));
        boolean isFunction = key.equals("AC") || key.equals("( )") || key.equals("%") || key.equals("⌫");
        int background = isEquals ? R.color.calc_accent
            : isOperator ? R.color.calc_operator : isFunction ? R.color.calc_function : R.color.calc_digit;
        view.setTextColor(isEquals ? 0xFF17181C : isOperator ? color(R.color.calc_accent)
            : color(R.color.calc_display_text));
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(22));
        shape.setColor(color(background));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), shape, null));
        view.setContentDescription(describe(key));
        view.setOnClickListener((v) -> {
            v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
            press(key);
        });
        if (key.equals("⌫")) {
            view.setOnLongClickListener((v) -> {
                clear();
                return true;
            });
        }
        return view;
    }

    private static String describe(String key) {
        switch (key) {
            case "AC": return "Clear";
            case "( )": return "Brackets";
            case "⌫": return "Delete";
            case "÷": return "Divide";
            case "×": return "Multiply";
            case "−": return "Minus";
            case "+": return "Plus";
            case "%": return "Percent";
            case ".": return "Point";
            case "=": return "Equals";
            default: return key;
        }
    }

    private void press(String key) {
        switch (key) {
            case "AC":
                clear();
                return;
            case "⌫":
                if (isShowingResult) {
                    clear();
                } else if (expression.length() > 0) {
                    expression.setLength(expression.length() - 1);
                }
                break;
            case "=":
                pressEquals();
                return;
            case "( )":
                startTyping(false);
                expression.append(shouldClose() ? ')' : '(');
                break;
            case ".":
                startTyping(false);
                if (currentNumberHasPoint()) return;
                if (expression.length() == 0 || !Character.isDigit(last())) expression.append('0');
                expression.append('.');
                break;
            case "%":
                startTyping(true);
                if (expression.length() == 0 || !(Character.isDigit(last()) || last() == ')' || last() == '%')) return;
                expression.append('%');
                break;
            default:
                if (key.length() == 1 && Expression.isOperator(key.charAt(0))) {
                    appendOperator(key.charAt(0));
                } else {
                    startTyping(false);
                    expression.append(key);
                }
        }
        render();
    }

    // After a result, an operator carries on from it and a digit starts over
    private void startTyping(boolean keepResult) {
        if (isShowingResult && !keepResult) expression.setLength(0);
        isShowingResult = false;
    }

    private void appendOperator(char operator) {
        startTyping(true);
        if (expression.length() == 0) {
            if (operator == '−') expression.append(operator);
            return;
        }
        char last = last();
        if (Expression.isOperator(last)) {
            // "×−" is allowed so a negative number can follow; anything else replaces the operator
            if (operator == '−' && (last == '×' || last == '÷')) {
                expression.append(operator);
                return;
            }
            expression.setLength(expression.length() - 1);
            if (expression.length() > 0 && Expression.isOperator(last())) expression.setLength(expression.length() - 1);
            if (expression.length() == 0 && operator != '−') return;
        } else if (last == '(' && operator != '−') {
            return;
        }
        expression.append(operator);
    }

    private boolean shouldClose() {
        int open = 0;
        for (int i = 0; i < expression.length(); i++) {
            if (expression.charAt(i) == '(') open++;
            else if (expression.charAt(i) == ')') open--;
        }
        if (open <= 0 || expression.length() == 0) return false;
        char last = last();
        return Character.isDigit(last) || last == ')' || last == '%' || last == '.';
    }

    private boolean currentNumberHasPoint() {
        for (int i = expression.length() - 1; i >= 0; i--) {
            char c = expression.charAt(i);
            if (c == '.') return true;
            if (!Character.isDigit(c)) return false;
        }
        return false;
    }

    private char last() {
        return expression.charAt(expression.length() - 1);
    }

    private void pressEquals() {
        String keys = expression.toString();
        if (keys.isEmpty()) return;
        if (listener != null && listener.onEquals(keys)) return;
        try {
            String result = Expression.format(Expression.evaluate(keys));
            expression.setLength(0);
            expression.append(result.replace('-', '−'));
            isShowingResult = true;
            render();
        } catch (Expression.CalcException e) {
            previewView.setText(e.getMessage());
        }
    }

    private void render() {
        expressionView.setText(expression.length() == 0 ? "0" : expression);
        previewView.setText(preview());
    }

    private String preview() {
        if (isShowingResult) return "";
        String text = expression.toString();
        boolean hasOperation = false;
        for (int i = 1; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Expression.isOperator(c) || c == '%' || c == '(') hasOperation = true;
        }
        if (!hasOperation || Expression.isOperator(last())) return "";
        try {
            return Expression.format(Expression.evaluate(text)).replace('-', '−');
        } catch (Expression.CalcException e) {
            return "";
        }
    }

    private int color(int id) {
        return getContext().getColor(id);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
