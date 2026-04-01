#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

COLUMN_MAP = {
    "A": "number",
    "B": "artist",
    "C": "title",
    "D": "year",
    "E": "genre",
    "F": "label",
    "G": "catalogNumber",
    "H": "country",
    "I": "coverCondition",
    "J": "discCondition",
    "K": "notes",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert the vinyl collection spreadsheet into the JSON used by the UI."
    )
    parser.add_argument("source", type=Path, help="Path to the source XLSX file")
    parser.add_argument("output", type=Path, help="Path to the generated JSON file")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workbook = WorkbookReader(args.source)
    collection_rows = workbook.read_sheet("Coleccion")
    grading_rows = workbook.read_sheet("Referencia")

    payload = build_payload(collection_rows, grading_rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(payload['records'])} records to {args.output}")


class WorkbookReader:
    def __init__(self, workbook_path: Path) -> None:
        self.workbook_path = workbook_path
        self.archive = ZipFile(workbook_path)
        self.shared_strings = self._read_shared_strings()
        self.sheet_targets = self._read_sheet_targets()

    def _read_shared_strings(self) -> List[str]:
        if "xl/sharedStrings.xml" not in self.archive.namelist():
            return []

        root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
        shared_strings: List[str] = []
        for item in root.findall("main:si", NS):
            shared_strings.append("".join(text.text or "" for text in item.iterfind(".//main:t", NS)))
        return shared_strings

    def _read_sheet_targets(self) -> Dict[str, str]:
        workbook_root = ET.fromstring(self.archive.read("xl/workbook.xml"))
        rels_root = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"].lstrip("/") for rel in rels_root}

        targets: Dict[str, str] = {}
        for sheet in workbook_root.find("main:sheets", NS):
            name = sheet.attrib["name"]
            relation_id = sheet.attrib[
                "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
            ]
            targets[name] = rel_map[relation_id]
        return targets

    def read_sheet(self, starts_with: str) -> List[Tuple[int, Dict[str, str]]]:
        normalized_prefix = normalize_text(starts_with)
        sheet_name = next(
            name
            for name in self.sheet_targets.keys()
            if normalize_text(name).startswith(normalized_prefix)
        )
        root = ET.fromstring(self.archive.read(self.sheet_targets[sheet_name]))
        sheet_data = root.find("main:sheetData", NS)

        rows: List[Tuple[int, Dict[str, str]]] = []
        for row in sheet_data.findall("main:row", NS):
            row_number = int(row.attrib.get("r", "0"))
            cells: Dict[str, str] = {}
            for cell in row.findall("main:c", NS):
                cell_ref = cell.attrib.get("r", "")
                column = re.match(r"[A-Z]+", cell_ref)
                if not column:
                    continue
                cells[column.group(0)] = self._cell_value(cell)
            rows.append((row_number, cells))

        return rows

    def _cell_value(self, cell: ET.Element) -> str:
        cell_type = cell.attrib.get("t")
        if cell_type == "inlineStr":
            return "".join(text.text or "" for text in cell.iterfind(".//main:t", NS)).strip()

        value = cell.find("main:v", NS)
        if value is None or value.text is None:
            return ""

        text_value = value.text.strip()
        if cell_type == "s" and text_value:
            return self.shared_strings[int(text_value)].strip()
        return text_value


def build_payload(
    collection_rows: List[Tuple[int, Dict[str, str]]],
    grading_rows: List[Tuple[int, Dict[str, str]]],
) -> Dict[str, object]:
    title = collection_rows[0][1].get("A", "Vinyl Collection").replace("  ", " ").strip()
    records = []

    for row_number, cells in collection_rows:
        if row_number < 3:
            continue

        if not cells.get("A") or not cells.get("B") or not cells.get("C"):
            continue

        record = {}
        for column, field_name in COLUMN_MAP.items():
            record[field_name] = clean_value(cells.get(column, ""))

        record["id"] = slugify(f"{record['number']}-{record['artist']}-{record['title']}")
        record["genreGroups"] = split_genres(record["genre"])
        record["yearSort"] = extract_year(record["year"])
        record["searchText"] = normalize_text(
            " ".join(
                [
                    record["artist"],
                    record["title"],
                    record["year"],
                    record["genre"],
                    record["label"],
                    record["catalogNumber"],
                    record["country"],
                    record["coverCondition"],
                    record["discCondition"],
                    record["notes"],
                ]
            )
        )
        records.append(record)

    grading_guide = []
    for row_number, cells in grading_rows:
        if row_number < 2:
            continue
        grade = clean_value(cells.get("A", ""))
        description = clean_value(cells.get("B", ""))
        if grade:
            grading_guide.append({"grade": grade, "description": description})

    return {
        "collectionName": title,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "recordCount": len(records),
        "records": records,
        "gradingGuide": grading_guide,
    }


def clean_value(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def split_genres(value: str) -> List[str]:
    if not value:
        return []
    return [part.strip() for part in value.split("/") if part.strip()]


def extract_year(value: str) -> int | None:
    if not value:
        return None
    match = re.search(r"(19|20)\d{2}", value)
    if match:
        return int(match.group(0))
    return None


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    return "".join(character for character in normalized if not unicodedata.combining(character)).lower()


def slugify(value: str) -> str:
    normalized = normalize_text(value)
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")


if __name__ == "__main__":
    main()
