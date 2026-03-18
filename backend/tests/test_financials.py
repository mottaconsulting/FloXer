"""
Unit tests for financial computation functions in app.py.
Run with: pytest backend/tests/
"""
import sys
import os
from datetime import datetime

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import (
    _calc_revenue_expense,
    complete_budget_to_fy,
    _build_sales_series,
)


def test_revenue_sign_convention():
    """Revenue with negative net converts to positive revenue value."""
    df = pd.DataFrame({
        "ACCOUNT_TYPE": ["REVENUE", "EXPENSE"],
        "ACCOUNT_NAME": ["Sales", "Rent"],
        "DATA_CATEGORY": ["", ""],
        "JOURNAL_DATE": [datetime(2024, 1, 1), datetime(2024, 1, 2)],
        "NET_AMOUNT": [-100.0, 30.0],
    })
    rev, exp = _calc_revenue_expense(df)
    assert rev == 100.0
    assert exp == 30.0


def test_complete_budget_fills_missing_months():
    """complete_budget_to_fy fills in months that have no data."""
    df = pd.DataFrame({
        "ACCOUNT_TYPE": ["REVENUE", "REVENUE"],
        "ACCOUNT_NAME": ["Sales", "Sales"],
        "DATA_CATEGORY": ["", ""],
        "JOURNAL_DATE": [datetime(2024, 1, 1), datetime(2024, 3, 1)],
        "NET_AMOUNT": [-100.0, -120.0],
    })
    fy_start = datetime(2024, 1, 1)
    fy_end = datetime(2024, 3, 31)
    completed, filled = complete_budget_to_fy(df, fy_start, fy_end)
    assert len(completed) == 3
    assert filled >= 1


def test_build_sales_series_length():
    """Sales series arrays match the number of FY months."""
    empty = pd.DataFrame({
        "ACCOUNT_TYPE": pd.Series(dtype=str),
        "ACCOUNT_NAME": pd.Series(dtype=str),
        "DATA_CATEGORY": pd.Series(dtype=str),
        "JOURNAL_DATE": pd.Series(dtype="datetime64[ns]"),
        "NET_AMOUNT": pd.Series(dtype=float),
    })
    fy_start = datetime(2024, 1, 1)
    fy_end = datetime(2024, 12, 31)
    series = _build_sales_series(empty, empty, fy_start, fy_end, datetime(2024, 6, 15))
    assert len(series["labels"]) == 12
    assert len(series["actual_monthly"]) == 12
    assert len(series["projected_monthly"]) == 12
