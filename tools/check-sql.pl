#!/usr/bin/perl
# Verificador de db/schema.sql sin necesidad de una base.
#
# Tokeniza igual que el parser de Postgres para lo que importa acá:
#   -- comentario de linea      /* comentario en bloque (anidable) */
#   'literal con '' escapado'   $tag$ dollar quoting $tag$
# y despues parte en sentencias por el ; de nivel superior.
#
# Reporta: sentencias, parentesis desbalanceados, literales o dollar quotes
# sin cerrar, y comentarios de bloque sin cerrar. Es lo que hizo fallar el
# primer deploy ("mismatched parentheses").

use strict;
use warnings;

my $file = $ARGV[0] || 'db/schema.sql';
open my $fh, '<', $file or die "no puedo abrir $file: $!\n";
my $s = do { local $/; <$fh> };
close $fh;

my $len   = length $s;
my $i     = 0;
my $line  = 1;
my @stmts;                 # [texto, linea_inicio]
my $cur   = '';
my $start = 1;
my $depth = 0;             # parentesis de la sentencia actual
my @problemas;

sub fin_sentencia {
  my $t = $cur;
  $t =~ s/^\s+|\s+$//g;
  push @stmts, [$t, $start, $depth] if length $t;
  $cur = ''; $depth = 0; $start = $line;
}

while ($i < $len) {
  my $c  = substr($s, $i, 1);
  my $c2 = substr($s, $i, 2);

  # comentario de linea
  if ($c2 eq '--') {
    $i++ while $i < $len && substr($s, $i, 1) ne "\n";
    next;
  }
  # comentario en bloque (Postgres los anida)
  if ($c2 eq '/*') {
    my $nivel = 1; $i += 2;
    while ($i < $len && $nivel > 0) {
      my $d2 = substr($s, $i, 2);
      if    ($d2 eq '/*') { $nivel++; $i += 2; }
      elsif ($d2 eq '*/') { $nivel--; $i += 2; }
      else { $line++ if substr($s, $i, 1) eq "\n"; $i++; }
    }
    push @problemas, "comentario en bloque sin cerrar (abre cerca de la linea $line)" if $nivel > 0;
    next;
  }
  # literal entre comillas simples ('' es un apostrofe escapado)
  if ($c eq "'") {
    my $ini = $line; $i++;
    while ($i < $len) {
      my $d = substr($s, $i, 1);
      if ($d eq "'") {
        if (substr($s, $i + 1, 1) eq "'") { $i += 2; next; }
        $i++; last;
      }
      $line++ if $d eq "\n";
      $i++;
    }
    push @problemas, "literal sin cerrar abierto en la linea $ini" if $i >= $len;
    next;
  }
  # identificador entre comillas dobles
  if ($c eq '"') {
    my $ini = $line; $i++;
    while ($i < $len && substr($s, $i, 1) ne '"') { $line++ if substr($s, $i, 1) eq "\n"; $i++; }
    push @problemas, "identificador entre comillas sin cerrar en la linea $ini" if $i >= $len;
    $i++;
    next;
  }
  # dollar quoting: $$ o $tag$
  if ($c eq '$' && substr($s, $i) =~ /^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/) {
    my $tag = $1;
    my $ini = $line;
    my $pos = index($s, $tag, $i + length $tag);
    if ($pos < 0) {
      push @problemas, "dollar quote $tag abierto en la linea $ini y nunca cerrado";
      last;
    }
    my $cuerpo = substr($s, $i, $pos + length($tag) - $i);
    $line += ($cuerpo =~ tr/\n//);
    $cur  .= $cuerpo;
    $i = $pos + length $tag;
    next;
  }

  $depth++ if $c eq '(';
  $depth-- if $c eq ')';
  if ($c eq ';') { $cur .= $c; fin_sentencia(); $i++; next; }

  $line++ if $c eq "\n";
  $cur .= $c;
  $i++;
}
fin_sentencia();

my $malas = 0;
for my $st (@stmts) {
  my ($txt, $ln, $d) = @$st;
  next if $d == 0;
  $malas++;
  my $head = $txt; $head =~ s/\s+/ /g; $head = substr($head, 0, 90);
  push @problemas, sprintf("parentesis desbalanceados (%+d) en la sentencia que empieza en la linea %d: %s", $d, $ln, $head);
}

# Un vistazo a lo que se crea, para confirmar que estan todas las tablas nuevas.
my @tablas = ($s =~ /create table if not exists\s+([a-z_]+)/gi);
my @indices = ($s =~ /create (?:unique )?index if not exists\s+([a-z_]+)/gi);
my @triggers = ($s =~ /create trigger\s+([a-z_]+)/gi);
my @funcs = ($s =~ /create or replace function\s+([a-z_]+)/gi);
my @seqs = ($s =~ /create sequence if not exists\s+([a-z_]+)/gi);

printf "archivo      : %s\n", $file;
printf "sentencias   : %d\n", scalar @stmts;
printf "tablas       : %d (%s)\n", scalar @tablas, join(', ', @tablas);
printf "indices      : %d\n", scalar @indices;
printf "secuencias   : %d (%s)\n", scalar @seqs, join(', ', @seqs);
printf "funciones    : %d (%s)\n", scalar @funcs, join(', ', @funcs);
printf "triggers     : %d\n", scalar @triggers;
printf "desbalanceadas: %d\n", $malas;

if (@problemas) {
  print "\nPROBLEMAS:\n";
  print "  - $_\n" for @problemas;
  exit 1;
}
print "\nOK: el esquema parsea limpio.\n";
exit 0;
