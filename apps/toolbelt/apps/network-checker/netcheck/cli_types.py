"""Reusable argparse value validation."""
import argparse


def positive_int(value):
    """Parse a strictly positive integer."""
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed
