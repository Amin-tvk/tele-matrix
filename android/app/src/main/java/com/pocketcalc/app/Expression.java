package com.pocketcalc.app;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

// Evaluates what the keypad types: numbers, + − × ÷, postfix % and brackets, with the usual precedence
final class Expression {
    static final class CalcException extends Exception {
        CalcException(String message) {
            super(message);
        }
    }

    private static final MathContext CONTEXT = MathContext.DECIMAL64;

    private final String text;
    private int pos;

    private Expression(String text) {
        this.text = text;
    }

    static BigDecimal evaluate(String text) throws CalcException {
        Expression expression = new Expression(text);
        BigDecimal value = expression.parseSum();
        if (expression.pos != text.length()) throw new CalcException("Error");
        return value;
    }

    static String format(BigDecimal value) {
        BigDecimal rounded = value.round(new MathContext(12, RoundingMode.HALF_UP)).stripTrailingZeros();
        if (rounded.compareTo(BigDecimal.ZERO) == 0) return "0";
        int digits = rounded.precision() - rounded.scale();
        if (digits > 12 || digits < -6) return rounded.toString().replace("E+", "e").replace("E", "e");
        return rounded.toPlainString();
    }

    static boolean isOperator(char c) {
        return c == '+' || c == '−' || c == '×' || c == '÷';
    }

    private BigDecimal parseSum() throws CalcException {
        BigDecimal value = parseProduct();
        while (pos < text.length()) {
            char c = text.charAt(pos);
            if (c == '+') {
                pos++;
                value = value.add(parseProduct(), CONTEXT);
            } else if (c == '−') {
                pos++;
                value = value.subtract(parseProduct(), CONTEXT);
            } else {
                break;
            }
        }
        return value;
    }

    private BigDecimal parseProduct() throws CalcException {
        BigDecimal value = parseUnary();
        while (pos < text.length()) {
            char c = text.charAt(pos);
            if (c == '×') {
                pos++;
                value = value.multiply(parseUnary(), CONTEXT);
            } else if (c == '÷') {
                pos++;
                BigDecimal divisor = parseUnary();
                if (divisor.compareTo(BigDecimal.ZERO) == 0) throw new CalcException("Can't divide by 0");
                value = value.divide(divisor, CONTEXT);
            } else if (c == '(' || Character.isDigit(c) || c == '.') {
                // "2(3)" multiplies
                value = value.multiply(parseUnary(), CONTEXT);
            } else {
                break;
            }
        }
        return value;
    }

    private BigDecimal parseUnary() throws CalcException {
        if (pos < text.length() && text.charAt(pos) == '−') {
            pos++;
            return parseUnary().negate();
        }
        BigDecimal value = parsePrimary();
        while (pos < text.length() && text.charAt(pos) == '%') {
            pos++;
            value = value.divide(BigDecimal.valueOf(100), CONTEXT);
        }
        return value;
    }

    private BigDecimal parsePrimary() throws CalcException {
        if (pos >= text.length()) throw new CalcException("Error");
        char c = text.charAt(pos);
        if (c == '(') {
            pos++;
            BigDecimal value = parseSum();
            // A bracket left open closes itself at the end, as on phone calculators
            if (pos < text.length() && text.charAt(pos) == ')') pos++;
            else if (pos < text.length()) throw new CalcException("Error");
            return value;
        }
        int start = pos;
        while (pos < text.length() && (Character.isDigit(text.charAt(pos)) || text.charAt(pos) == '.')) pos++;
        if (start == pos) throw new CalcException("Error");
        String number = text.substring(start, pos);
        if (number.equals(".")) throw new CalcException("Error");
        try {
            return new BigDecimal(number.endsWith(".") ? number + "0" : number);
        } catch (NumberFormatException e) {
            throw new CalcException("Error");
        }
    }
}
